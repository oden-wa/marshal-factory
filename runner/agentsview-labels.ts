import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { databaseConnectionString } from "../db/connection";
import { CLAUDE_SESSION_ID, type LabelRow } from "../lib/agentsview-labels";
import { agentsviewUrlSchema, type FactoryConfig } from "../lib/config";
import { stateDir } from "../lib/outbox";
import { LabelStateChangedError, type LabelReceipt, type StateFile, type StateOperation, type StateReply, type StateRequest, type StateResult, stateFile } from "./agentsview-label-state";

const PAGE_SIZE = 25;
const TICK_MS = 10_000;
const HTTP_MS = 3_000;
const WINDOW_MS = 7 * 86_400_000;
const STATE_WORKER_MS = 60_000;
const labelStatePath = () => join(stateDir(), "agentsview-labels.sqlite");
const workerScript = fileURLToPath(new URL("./agentsview-label-state-worker.ts", import.meta.url));
const execFileAsync = promisify(execFile);

type Cursor = { session: string; agent: string };
type ReadPage = (after: Cursor, limit: number, checkTime: () => number, signal: AbortSignal) => Promise<LabelRow[]>;
const start: Cursor = { session: "", agent: "" };

class DeadlineExceeded extends Error {
  constructor() {
    super("AgentsView label tick deadline exceeded");
  }
}

// hooks/report.ts hashes SessionStart events. The MCP reporter uses a mcp-start: prefix.
// The job's provider can change between attempts, so classify the run from its own event.
const candidatesSql = `
  SELECT r.session_id, r.job_key, r.branch, target.agent_id
  FROM runs r
  JOIN jobs j ON j.key = r.job_key
  CROSS JOIN LATERAL (
    SELECT NULL::text AS agent_id
    UNION ALL
    SELECT a.agent_id FROM agents a
    WHERE a.session_id = r.session_id AND a.agent_id <> '' AND a.agent_id NOT LIKE 'codex:%'
  ) target
  WHERE r.last_event_at >= $1 AND r.session_id >= $2 AND r.session_id ~ $4
    AND EXISTS (
      SELECT 1 FROM events e WHERE e.session_id = r.session_id
        AND e.kind = 'session_start' AND e.event_id ~ '^[0-9a-f]{64}$'
    )
    AND (r.session_id, coalesce(target.agent_id, '')) > ($2, $3)
  ORDER BY r.session_id, coalesce(target.agent_id, '')
  LIMIT $5
`;

const readCandidates: ReadPage = async (after, limit, checkTime, signal) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for AgentsView labels");
  const timeout = checkTime();
  const client = new Client({
    connectionString: databaseConnectionString(databaseUrl),
    connectionTimeoutMillis: timeout,
    query_timeout: timeout,
  });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= client.end().catch(() => undefined));
  const onAbort = () => void close();
  // A connection error between queries still has a listener.
  client.on("error", onAbort);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect();
    checkTime();
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${checkTime()}`);
    checkTime();
    const { rows } = await client.query<LabelRow>(candidatesSql, [
      new Date(Date.now() - WINDOW_MS), after.session, after.agent, CLAUDE_SESSION_ID.source, limit,
    ]);
    checkTime();
    await client.query("ROLLBACK");
    return rows;
  } finally {
    signal.removeEventListener("abort", onAbort);
    void close();
  }
};

async function beforeDeadline<T>(checkTime: () => number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = checkTime();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineExceeded()), timeout);
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  try {
    return await Promise.race([expired, work(controller.signal)]);
  } finally {
    clearTimeout(timer);
  }
}

const schema = `
  CREATE TABLE endpoint (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    url TEXT NOT NULL
  ) STRICT;
  CREATE TABLE attributions (
    session_id TEXT PRIMARY KEY NOT NULL,
    job TEXT NOT NULL,
    attempt INTEGER CHECK (attempt BETWEEN 1 AND 9007199254740991)
  ) STRICT;
  CREATE TABLE targets (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES attributions(session_id)
  ) STRICT;
`;

export function initializeSessionLabelState(rawUrl: string, path = labelStatePath()) {
  const url = agentsviewUrlSchema.parse(rawUrl);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dir, ".agentsview-labels-"));
  try {
    const fresh = join(staging, "labels.sqlite");
    writeFileSync(fresh, "", { flag: "wx", mode: 0o600 });
    const db = new Database(fresh, { create: false });
    try {
      db.exec("PRAGMA synchronous = FULL");
      db.transaction(() => {
        db.exec(schema);
        db.query("INSERT INTO endpoint (singleton, url) VALUES (1, ?)").run(url);
      }).immediate();
    } finally {
      db.close();
    }
    // Publish the committed database in one step. A hard link fails when the destination exists.
    try {
      linkSync(fresh, path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error(`AgentsView label state already exists at ${path}`);
      }
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return path;
}

async function runStateWorker(request: StateRequest): Promise<StateResult> {
  const worker = execFileAsync(process.execPath, [workerScript], { timeout: STATE_WORKER_MS, killSignal: "SIGKILL" });
  worker.child.stdin?.on("error", () => undefined);
  worker.child.stdin?.end(JSON.stringify(request));
  const { stdout } = await worker;
  const reply: StateReply = JSON.parse(stdout);
  if ("error" in reply) throw reply.fileChanged ? new LabelStateChangedError() : new Error(reply.error);
  return reply.result;
}

type LabelIssue = { id: string; session: string; conflict: string } | { id: string; session: string; error: string };
type LabelResult = {
  sent: number;
  failed: number;
  conflicts: number;
  timedOut: boolean;
  issues: LabelIssue[];
  error?: string;
};

type LabelOptions = {
  path?: string;
  readPage?: ReadPage;
  send?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  runState?: typeof runStateWorker;
};

type StateUpdate = Exclude<StateOperation, { kind: "prepare" }>
  | { kind: "prepare"; rows: readonly LabelRow[]; hasMore: boolean };
type PendingState = {
  operation: StateUpdate;
  reply: Promise<{ result: StateResult } | { error: unknown }>;
};
type PreparedPage = {
  rows: readonly LabelRow[];
  hasMore: boolean;
  plans: StateResult["plans"];
  next: number;
};

export function createSessionLabelSync(
  config: FactoryConfig["agentsview"],
  options: LabelOptions = {},
): () => Promise<LabelResult | { disabled: true }> {
  if (!config) return async () => ({ disabled: true });
  const url = agentsviewUrlSchema.parse(config.url);
  const origin = new URL(url).origin;
  const {
    path = labelStatePath(),
    readPage = readCandidates,
    send = fetch,
    now = () => performance.now(),
    runState = runStateWorker,
  } = options;
  let pendingState: PendingState | undefined;
  let trustedFile: StateFile | undefined;
  let preparedPage: PreparedPage | undefined;
  let unsavedReceipt: LabelReceipt | undefined;
  let changedOutsideRunner = false;
  let after = start;
  let activeTick: Promise<LabelResult> | undefined;

  function checkFile(expected: StateFile) {
    if (stateFile(path).version !== expected.version) throw new LabelStateChangedError();
  }

  async function finishState({ operation, reply: pending }: PendingState, checkTime: () => number) {
    // If the tick expires first, the next tick must check the same worker's result.
    const reply = await beforeDeadline(checkTime, () => pending);
    pendingState = undefined;
    if ("error" in reply) throw reply.error;
    checkFile(reply.result.file);
    trustedFile = reply.result.file;
    if (operation.kind === "prepare") {
      preparedPage = { rows: operation.rows, hasMore: operation.hasMore, plans: reply.result.plans, next: 0 };
    }
    if (operation.kind === "record") unsavedReceipt = undefined;
    checkTime();
    return reply.result.file;
  }

  function updateState(operation: StateUpdate, checkTime: () => number) {
    checkTime();
    const file = trustedFile ?? stateFile(path);
    const reply = runState({ path, url, file, operation }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    pendingState = { operation, reply };
    return finishState(pendingState, checkTime);
  }

  async function tick(): Promise<LabelResult> {
    const deadline = now() + TICK_MS;
    const checkTime = () => {
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) throw new DeadlineExceeded();
      return remaining;
    };
    const result: LabelResult = { sent: 0, failed: 0, conflicts: 0, timedOut: false, issues: [] };
    try {
      if (changedOutsideRunner) throw new LabelStateChangedError();
      if (pendingState) await finishState(pendingState, checkTime);
      let file = trustedFile ?? await updateState({ kind: "inspect" }, checkTime);
      checkFile(file);
      if (unsavedReceipt) file = await updateState({ kind: "record", receipt: unsavedReceipt }, checkTime);
      if (!preparedPage) {
        const candidates = await beforeDeadline(checkTime, (signal) => readPage(after, PAGE_SIZE + 1, checkTime, signal));
        checkFile(file);
        if (candidates.length > 0) {
          const rows = candidates.slice(0, PAGE_SIZE);
          file = await updateState({ kind: "prepare", rows, hasMore: candidates.length > PAGE_SIZE }, checkTime);
        }
      }
      const page = preparedPage;
      while (page && page.next < page.rows.length) {
        checkTime();
        const row = page.rows[page.next];
        const planned = page.plans[page.next];
        if (planned) {
          checkFile(file);
          const { id, session } = planned;
          if (planned.kind === "conflict") {
            result.conflicts++;
            result.issues.push(planned);
          } else if (!planned.accepted) {
            const { body } = planned;
            const timeout = checkTime();
            try {
              const response = await send(`${url}/api/v1/sessions/${encodeURIComponent(id)}/labels`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json", Origin: origin },
                body,
                redirect: "error",
                signal: AbortSignal.timeout(Math.min(HTTP_MS, timeout)),
              });
              void response.body?.cancel().catch(() => undefined);
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              unsavedReceipt = { id, body };
              result.sent++;
            } catch (error) {
              result.failed++;
              result.issues.push({ id, session, error: error instanceof Error ? error.message : String(error) });
            }
          }
        }
        after = { session: row.session_id, agent: row.agent_id ?? "" };
        page.next++;
        if (unsavedReceipt) file = await updateState({ kind: "record", receipt: unsavedReceipt }, checkTime);
      }
      if (!page?.hasMore) after = start;
      preparedPage = undefined;
      checkTime();
    } catch (error) {
      if (error instanceof LabelStateChangedError) changedOutsideRunner = true;
      result.timedOut = error instanceof DeadlineExceeded || now() >= deadline || (
        error instanceof Error && "code" in error && error.code === "57014"
      );
      if (!(error instanceof DeadlineExceeded)) result.error = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  return () => (activeTick ??= tick().finally(() => { activeTick = undefined; }));
}
