import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { attributionLabels, labelCandidate, resolveAttribution, type Attribution, type LabelRow } from "../lib/agentsview-labels";

export type StateFile = { identity: string; version: string };
export type LabelReceipt = { id: string; body: string };
export type StateOperation =
  | { kind: "inspect" }
  | { kind: "prepare"; rows: readonly LabelRow[] }
  | { kind: "record"; receipt: LabelReceipt };

type LabelPlan = { id: string; session: string } & (
  | { kind: "send"; body: string; accepted: boolean }
  | { kind: "conflict"; conflict: "target owner" | "attribution"; owner?: string; saved?: Attribution | null; observed?: Attribution }
);

export type StateRequest = { path: string; url: string; file: StateFile; operation: StateOperation };
export type StateResult = { file: StateFile; plans: (LabelPlan | null)[] };
export type StateReply = { result: StateResult } | { error: string; fileChanged: boolean };

export class LabelStateChangedError extends Error {
  constructor() {
    super("AgentsView label state changed outside the runner. Reconcile the state and restart the runner");
  }
}

export function stateFile(path: string): StateFile {
  const file = statSync(path, { bigint: true });
  if (!file.isFile() || file.size === BigInt(0)) throw new Error("AgentsView label state is missing or empty");
  const identity = `${file.dev}:${file.ino}`;
  return { identity, version: `${identity}:${file.size}:${file.mtimeNs}:${file.ctimeNs}` };
}

function prepare(db: Database, rows: readonly LabelRow[]): (LabelPlan | null)[] {
  // State files initialized before receipts still use the same attribution and ownership tables.
  db.exec(`
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY NOT NULL REFERENCES targets(id),
      body TEXT NOT NULL
    ) STRICT
  `);
  const getAttribution = db.query<Attribution>("SELECT job, attempt FROM attributions WHERE session_id = ?");
  const saveAttribution = db.query(`
    INSERT INTO attributions (session_id, job, attempt) VALUES (?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET attempt = excluded.attempt
  `);
  const getOwner = db.query<{ session_id: string }>("SELECT session_id FROM targets WHERE id = ?");
  const saveOwner = db.query("INSERT INTO targets (id, session_id) VALUES (?, ?)");
  const getReceipt = db.query<{ body: string }>("SELECT body FROM receipts WHERE id = ?");
  return rows.map((row): LabelPlan | null => {
    const candidate = labelCandidate(row);
    if (!candidate) return null;
    const { id, session, attribution } = candidate;
    const saved = getAttribution.get(session);
    const resolved = resolveAttribution(saved, attribution);
    if (!resolved) return { kind: "conflict", id, session, conflict: "attribution", saved, observed: attribution };
    const owner = getOwner.get(id);
    if (owner && owner.session_id !== session) {
      return { kind: "conflict", id, session, conflict: "target owner", owner: owner.session_id };
    }
    if (resolved !== saved) saveAttribution.run(session, resolved.job, resolved.attempt);
    if (!owner) saveOwner.run(id, session);
    const body = JSON.stringify({ add: attributionLabels(resolved) });
    return { kind: "send", id, session, body, accepted: getReceipt.get(id)?.body === body };
  });
}

function record(db: Database, { id, body }: LabelReceipt) {
  db.query(`
    INSERT INTO receipts (id, body) VALUES (?, ?)
    ON CONFLICT (id) DO UPDATE SET body = excluded.body
  `).run(id, body);
}

export function runStateOperation({ path, url, file, operation }: StateRequest): StateResult {
  if (stateFile(path).version !== file.version) throw new LabelStateChangedError();
  const db = new Database(path, { create: false });
  let plans: StateResult["plans"] = [];
  try {
    db.exec("PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
    if (operation.kind === "inspect") {
      const verdict = db.query<{ integrity_check: string }>("PRAGMA integrity_check(1)").get();
      if (verdict?.integrity_check !== "ok" || db.query("SELECT 1 FROM pragma_foreign_key_check LIMIT 1").get()) {
        throw new Error("AgentsView label state failed SQLite integrity checks");
      }
    }
    const endpoint = db.query<{ url: string }>("SELECT url FROM endpoint WHERE singleton = 1").get();
    if (endpoint?.url !== url) throw new Error("AgentsView label state URL does not match agentsview.url");
    if (operation.kind === "prepare") {
      plans = db.transaction(() => prepare(db, operation.rows)).immediate();
    } else if (operation.kind === "record") {
      db.transaction(() => record(db, operation.receipt)).immediate();
    }
  } finally {
    db.close();
  }
  const updated = stateFile(path);
  if (updated.identity !== file.identity) throw new LabelStateChangedError();
  return { file: updated, plans };
}
