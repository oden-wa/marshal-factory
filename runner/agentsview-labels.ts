import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { CLAUDE_SESSION_ID, type LabelRow } from "../lib/agentsview-labels";
import { agentsviewUrlSchema, type FactoryConfig } from "../lib/config";
import { stateDir } from "../lib/outbox";
import { LabelStateChangedError, type LabelReceipt, type StateFile, type StateOperation, type StateReply, type StateRequest, stateFile } from "./agentsview-label-state";

const PAGE_SIZE = 25;
const TICK_MS = 10_000;
const HTTP_MS = 3_000;
const WINDOW_MS = 7 * 86_400_000;
const STATE_CHECK_MS = 60_000;
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
  const parsed = new URL(databaseUrl);
  if (parsed.searchParams.get("sslmode") === "require") parsed.searchParams.set("sslmode", "verify-full");
  const timeout = checkTime();
  const client = new Client({
    connectionString: parsed.href,
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

async function runStateWorker(request: StateRequest, timeout: number) {
  const worker = execFileAsync(process.execPath, [workerScript], { timeout, killSignal: "SIGKILL" });
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
  verifyState?: (request: StateRequest) => Promise<void>;
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
    verifyState: verify = async (request) => { await runStateWorker(request, STATE_CHECK_MS); },
  } = options;
  let verified: { file: StateFile; error: Promise<Error | undefined> } | undefined;
  let trustedIdentity: string | undefined;
  let changedOutsideRunner = false;
  let after = start;

  function checkFileIdentity(file: StateFile, expected?: StateFile) {
    if (trustedIdentity !== undefined &&
        (trustedIdentity !== file.identity || (expected && expected.version !== file.version))) {
      changedOutsideRunner = true;
    }
    if (changedOutsideRunner) throw new LabelStateChangedError();
  }

  return async (): Promise<LabelResult> => {
    const deadline = now() + TICK_MS;
    const checkTime = () => {
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) throw new DeadlineExceeded();
      return remaining;
    };
    const result: LabelResult = { sent: 0, failed: 0, conflicts: 0, timedOut: false, issues: [] };
    try {
      const file = stateFile(path);
      checkFileIdentity(file, verified?.file);
      checkTime();
      if (verified?.file.version !== file.version) {
        const error = verify({ path, url, file, operation: { kind: "inspect" } }).then(
          () => undefined,
          (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause)),
        );
        verified = { file, error };
      }
      const verification = verified;
      const inspectionError = await beforeDeadline(checkTime, () => verification.error);
      if (inspectionError) {
        if (trustedIdentity !== undefined && inspectionError instanceof LabelStateChangedError) changedOutsideRunner = true;
        verified = undefined;
        throw inspectionError;
      }
      const checkFile = () => {
        const current = stateFile(path);
        checkFileIdentity(current, verification.file);
        if (verification.file.version !== current.version) {
          throw new LabelStateChangedError();
        }
      };
      checkTime();
      checkFile();
      trustedIdentity = file.identity;
      const page = await beforeDeadline(checkTime, (signal) => readPage(after, PAGE_SIZE + 1, checkTime, signal));
      checkFile();
      const update = async (operation: StateOperation) => {
        try {
          const updated = await beforeDeadline(checkTime, () =>
            runStateWorker({ path, url, file: verification.file, operation }, checkTime()),
          );
          checkTime();
          checkFileIdentity(updated.file);
          verification.file = updated.file;
          return updated.plans;
        } catch (error) {
          if (error instanceof LabelStateChangedError) changedOutsideRunner = true;
          // The worker may have completed a transaction before the deadline expired.
          verified = undefined;
          if (now() >= deadline) throw new DeadlineExceeded();
          throw error;
        }
      };
      const rows = page.slice(0, PAGE_SIZE);
      const plans = rows.length > 0 ? await update({ kind: "prepare", rows }) : [];
      for (const [index, row] of rows.entries()) {
        checkTime();
        const planned = plans[index];
        let receipt: LabelReceipt | undefined;
        if (planned) {
          checkFile();
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
              receipt = { id, body };
              result.sent++;
            } catch (error) {
              result.failed++;
              result.issues.push({ id, session, error: error instanceof Error ? error.message : String(error) });
            }
          }
        }
        after = { session: row.session_id, agent: row.agent_id ?? "" };
        if (receipt) await update({ kind: "record", receipt });
      }
      if (page.length <= PAGE_SIZE) after = start;
      checkTime();
    } catch (error) {
      result.timedOut = error instanceof DeadlineExceeded || now() >= deadline || (
        error instanceof Error && "code" in error && error.code === "57014"
      );
      if (!(error instanceof DeadlineExceeded)) result.error = error instanceof Error ? error.message : String(error);
    }
    return result;
  };
}
