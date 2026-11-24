import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { type BigIntStats, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { attributionLabels, CLAUDE_SESSION_ID, labelCandidate, resolveAttribution, type Attribution, type LabelRow } from "../lib/agentsview-labels";
import { agentsviewUrlSchema, type FactoryConfig } from "../lib/config";
import { stateDir } from "../lib/outbox";

const PAGE_SIZE = 25;
const TICK_MS = 10_000;
const HTTP_MS = 3_000;
const WINDOW_MS = 7 * 86_400_000;
const MAX_ACKNOWLEDGED = 4_096;
const STATE_CHECK_MS = 60_000;
const labelStatePath = () => join(stateDir(), "agentsview-labels.sqlite");
const checkScript = fileURLToPath(new URL("./check-agentsview-label-state.ts", import.meta.url));
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
    connectionString: databaseUrl.replace("sslmode=require", "sslmode=verify-full"),
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

async function verifyState(path: string) {
  await execFileAsync(process.execPath, [checkScript, path], { timeout: STATE_CHECK_MS, killSignal: "SIGKILL" });
}

function stateFile(path: string) {
  const file = statSync(path, { bigint: true });
  if (!file.isFile() || file.size === BigInt(0)) throw new Error("AgentsView label state is missing or empty");
  return file;
}

const sameFile = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && a.dev === b.dev;
const sameContents = (a: BigIntStats, b: BigIntStats) =>
  sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function openState(path: string, url: string, checkTime: () => number) {
  const db = new Database(path, { create: false });
  try {
    db.exec("PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
    checkTime();
    const endpoint = db.query<{ url: string }>("SELECT url FROM endpoint WHERE singleton = 1").get();
    if (endpoint?.url !== url) throw new Error("AgentsView label state URL does not match agentsview.url");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function prepareTarget(db: Database, checkTime: () => number) {
  const getAttribution = db.query<Attribution>("SELECT job, attempt FROM attributions WHERE session_id = ?");
  const saveAttribution = db.query(`
    INSERT INTO attributions (session_id, job, attempt) VALUES (?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET attempt = excluded.attempt
  `);
  const getOwner = db.query<{ session_id: string }>("SELECT session_id FROM targets WHERE id = ?");
  const saveOwner = db.query("INSERT INTO targets (id, session_id) VALUES (?, ?)");
  return ({ id, session, attribution }: NonNullable<ReturnType<typeof labelCandidate>>) => db.transaction(() => {
    const saved = getAttribution.get(session);
    const resolved = resolveAttribution(saved, attribution);
    if (!resolved) return { kind: "conflict", conflict: "attribution", saved, observed: attribution } as const;
    const owner = getOwner.get(id);
    if (owner && owner.session_id !== session) return { kind: "conflict", conflict: "target owner", owner: owner.session_id } as const;
    checkTime();
    if (resolved !== saved) saveAttribution.run(session, resolved.job, resolved.attempt);
    if (!owner) {
      checkTime();
      saveOwner.run(id, session);
    }
    checkTime();
    return { kind: "send", labels: attributionLabels(resolved), changed: resolved !== saved || !owner } as const;
  }).immediate();
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
  verifyState?: (path: string) => Promise<void>;
  maxAcknowledged?: number;
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
    verifyState: verify = verifyState,
    maxAcknowledged = MAX_ACKNOWLEDGED,
  } = options;
  const acknowledged = new Map<string, string>();
  let verified: { file: BigIntStats; result: Promise<boolean> } | undefined;
  let after = start;

  return async (): Promise<LabelResult> => {
    const deadline = now() + TICK_MS;
    const checkTime = () => {
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) throw new DeadlineExceeded();
      return remaining;
    };
    const result: LabelResult = { sent: 0, failed: 0, conflicts: 0, timedOut: false, issues: [] };
    let db: Database | undefined;
    try {
      const file = stateFile(path);
      checkTime();
      if (!verified || !sameContents(file, verified.file)) {
        verified = { file, result: verify(path).then(() => true, () => false) };
      }
      const verification = verified;
      if (!(await beforeDeadline(checkTime, () => verification.result))) {
        verified = undefined;
        throw new Error("AgentsView label state failed SQLite quick_check");
      }
      const checkFile = () => {
        if (!sameContents(verification.file, stateFile(path))) {
          throw new Error("AgentsView label state changed during the tick");
        }
      };
      checkTime();
      checkFile();
      db = openState(path, url, checkTime);
      const plan = prepareTarget(db, checkTime);
      checkFile();
      const page = await beforeDeadline(checkTime, (signal) => readPage(after, PAGE_SIZE + 1, checkTime, signal));
      checkTime();
      checkFile();
      for (const row of page.slice(0, PAGE_SIZE)) {
        checkTime();
        const candidate = labelCandidate(row);
        if (candidate) {
          checkFile();
          const planned = plan(candidate);
          const { id, session } = candidate;
          if (planned.kind === "conflict") {
            result.conflicts++;
            result.issues.push({ id, session, ...planned });
          } else {
            if (planned.changed) {
              const current = stateFile(path);
              if (!sameFile(verification.file, current)) throw new Error("AgentsView label state changed during the tick");
              verification.file = current;
            }
            const body = JSON.stringify({ add: planned.labels });
            if (acknowledged.get(id) !== body) {
              checkFile();
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
                acknowledged.delete(id);
                acknowledged.set(id, body);
                if (acknowledged.size > maxAcknowledged) {
                  const oldest = acknowledged.keys().next().value;
                  if (oldest !== undefined) acknowledged.delete(oldest);
                }
                result.sent++;
              } catch (error) {
                result.failed++;
                result.issues.push({ id, session, error: error instanceof Error ? error.message : String(error) });
              }
            }
          }
        }
        after = { session: row.session_id, agent: row.agent_id ?? "" };
      }
      if (page.length <= PAGE_SIZE) after = start;
      checkTime();
    } catch (error) {
      result.timedOut = error instanceof DeadlineExceeded || now() >= deadline || (
        error instanceof Error && "code" in error && error.code === "57014"
      );
      if (!(error instanceof DeadlineExceeded)) result.error = error instanceof Error ? error.message : String(error);
    } finally {
      db?.close();
    }
    return result;
  };
}
