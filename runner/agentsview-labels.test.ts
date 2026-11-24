import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LabelRow } from "../lib/agentsview-labels";
import { createSessionLabelSync, initializeSessionLabelState } from "./agentsview-labels";

declare const Bun: {
  serve(options: { hostname: string; port: number; fetch(request: Request): Response | Promise<Response> }):
    { url: URL; stop(closeActiveConnections: boolean): Promise<void> };
};

const endpoint = { url: "http://agentsview.invalid:8090" };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function unusedStatePath() {
  const dir = mkdtempSync(join(tmpdir(), "marshal-label-test-"));
  dirs.push(dir);
  return join(dir, "agentsview-labels.sqlite");
}

const newState = (url = endpoint.url) => initializeSessionLabelState(url, unusedStatePath());

const root = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const row = (n = 1, rest: Partial<LabelRow> = {}): LabelRow => ({
  session_id: root(n), job_key: "FAC-61", branch: "factory/FAC-61", agent_id: null, ...rest,
});
const accepted = () => new Response(null, { status: 204 });

test("refuses to read candidates or send a new attempt after a truncated state file and restart", async () => {
  const labels = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body: { add: string[] } = await request.json();
      for (const label of body.add) labels.add(label);
      return accepted();
    },
  });
  try {
    const config = { url: server.url.href };
    const path = newState(config.url);
    let branch = "factory/FAC-61";
    let reads = 0;
    const restart = () => createSessionLabelSync(config, {
      path,
      readPage: async () => {
        reads++;
        return [row(1, { branch })];
      },
    });
    expect(await restart()()).toMatchObject({ sent: 1 });
    expect([...labels]).toEqual(["mf.job=FAC-61", "mf.attempt=1"]);
    writeFileSync(path, "");
    branch = "factory/FAC-61-a2";
    const restarted = await restart()();
    expect([...labels]).toEqual(["mf.job=FAC-61", "mf.attempt=1"]);
    expect(restarted).toMatchObject({ sent: 0, error: "AgentsView label state is missing or empty" });
    expect(reads).toBe(1);
    expect(statSync(path).size).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("the initializer refuses to replace either an empty file or an initialized database", () => {
  const empty = unusedStatePath();
  writeFileSync(empty, "");
  expect(() => initializeSessionLabelState(endpoint.url, empty)).toThrow("already exists");
  expect(statSync(empty).size).toBe(0);

  const initialized = newState();
  const original = readFileSync(initialized);
  expect(() => initializeSessionLabelState("http://other.invalid", initialized)).toThrow("already exists");
  expect(readFileSync(initialized)).toEqual(original);
});

test("the initializer rejects invalid URLs before creating state", () => {
  const path = unusedStatePath();
  for (const url of ["not a URL", "file:///tmp/agentsview", "http://user@agentsview.invalid", "http://agentsview.invalid/#"]) {
    expect(() => initializeSessionLabelState(url, path)).toThrow();
    expect(existsSync(path)).toBe(false);
  }
});

test("commits attribution before sending and replays a lost response after restart", async () => {
  const path = newState();
  const bodies: unknown[] = [];
  let persisted: unknown;
  const readPage = async () => [row()];
  const first = createSessionLabelSync(endpoint, {
    path,
    readPage,
    send: async (_url, { body }) => {
      bodies.push(body);
      const saved = new Database(path, { readonly: true });
      try {
        persisted = saved.query(`
          SELECT targets.id, attributions.job, attributions.attempt
          FROM targets JOIN attributions USING (session_id)
        `).all();
      } finally {
        saved.close();
      }
      throw new Error("response lost");
    },
  });
  expect(await first()).toMatchObject({ failed: 1, sent: 0 });
  expect(persisted).toEqual([{ id: root(1), job: "FAC-61", attempt: 1 }]);
  const restarted = createSessionLabelSync(endpoint, {
    path,
    readPage,
    send: async (_url, { body }) => {
      bodies.push(body);
      return accepted();
    },
  });
  expect(await restarted()).toMatchObject({ sent: 1, failed: 0 });
  expect(bodies).toEqual(Array(2).fill(JSON.stringify({ add: ["mf.job=FAC-61", "mf.attempt=1"] })));
});

test("fills a missing attempt after restart and applies it to later children across conflicts", async () => {
  const path = newState();
  let rows = [row(1, { branch: null })];
  const requests: { id: string; body: unknown }[] = [];
  const restart = () => createSessionLabelSync(endpoint, {
    path,
    readPage: async () => rows,
    send: async (url, { body }) => {
      requests.push({ id: new URL(url).pathname.split("/").at(-2) ?? "", body });
      return accepted();
    },
  });
  expect(await restart()()).toMatchObject({ sent: 1 });
  const sync = restart();
  rows = [row(1, { branch: "factory/FAC-61-a2" })];
  expect(await sync()).toMatchObject({ sent: 1 });
  rows = [
    row(1, { job_key: "FAC-62", branch: "factory/FAC-62", agent_id: "unseen-conflicting-job" }),
    row(1, { branch: "factory/FAC-61-a3", agent_id: "unseen-conflicting-attempt" }),
  ];
  expect(await sync()).toMatchObject({ sent: 0, conflicts: 2 });
  rows = [row(1, { branch: null }), row(1, { branch: null, agent_id: "later-child" })];
  expect(await sync()).toMatchObject({ sent: 1, conflicts: 0 });
  expect(requests).toEqual([
    { id: root(1), body: '{"add":["mf.job=FAC-61"]}' },
    { id: root(1), body: '{"add":["mf.job=FAC-61","mf.attempt=2"]}' },
    { id: "agent-later-child", body: '{"add":["mf.job=FAC-61","mf.attempt=2"]}' },
  ]);
});

test("a child ID remains owned by its original parent after a restart", async () => {
  const path = newState();
  let rows = [row(1), row(1, { agent_id: "same-child" })];
  const requests: string[] = [];
  const restart = () => createSessionLabelSync(endpoint, {
    path,
    readPage: async () => rows,
    send: async (url) => {
      requests.push(new URL(url).pathname);
      return accepted();
    },
  });
  expect(await restart()()).toMatchObject({ sent: 2 });
  rows = [
    row(2, { job_key: "FAC-62", branch: "factory/FAC-62" }),
    row(2, { job_key: "FAC-62", branch: "factory/FAC-62", agent_id: "same-child" }),
  ];
  expect(await restart()()).toMatchObject({ conflicts: 1, sent: 1 });
  expect(requests).toEqual([root(1), "agent-same-child", root(2)].map((id) => `/api/v1/sessions/${id}/labels`));
});

test("a rejected child cannot set its proposed parent's attempt", async () => {
  const path = newState();
  let rows = [row(1, { agent_id: "taken" }), row(2, { branch: null })];
  const bodies: unknown[] = [];
  const sync = createSessionLabelSync(endpoint, {
    path,
    readPage: async () => rows,
    send: async (_url, { body }) => {
      bodies.push(body);
      return accepted();
    },
  });
  expect(await sync()).toMatchObject({ sent: 2 });
  rows = [row(2, { branch: "factory/FAC-61-a2", agent_id: "taken" })];
  expect(await sync()).toMatchObject({ sent: 0, conflicts: 1 });
  rows = [row(2, { branch: "factory/FAC-61-a3" })];
  expect(await sync()).toMatchObject({ sent: 1, conflicts: 0 });
  expect(bodies.at(-1)).toBe('{"add":["mf.job=FAC-61","mf.attempt=3"]}');
});

test("remembers successful PATCH requests across runner restarts", async () => {
  const path = newState();
  let sent = 0;
  const start = () => createSessionLabelSync(endpoint, {
    path,
    readPage: async () => [row(1), row(2)],
    send: async () => {
      sent++;
      return accepted();
    },
  });
  expect(await start()()).toMatchObject({ sent: 2 });
  expect(await start()()).toMatchObject({ sent: 0 });
  expect(sent).toBe(2);
});

test("records an accepted PATCH before the next request can use the rest of the tick", async () => {
  const path = newState();
  let clock = 0;
  const sync = createSessionLabelSync(endpoint, {
    path,
    now: () => clock,
    readPage: async () => [row(1), row(2)],
    send: async (url) => {
      if (url.includes(root(2))) {
        clock = 10_000;
        throw new Error("deadline");
      }
      return accepted();
    },
  });
  expect(await sync()).toMatchObject({ sent: 1, failed: 1, timedOut: true });
  const restarted = createSessionLabelSync(endpoint, {
    path,
    readPage: async () => [row(1)],
    send: async () => { throw new Error("a successful PATCH should not be retried"); },
  });
  expect(await restarted()).toMatchObject({ sent: 0, failed: 0 });
});

test("a slow integrity check leaves the tick without blocking reads on subsequent verified ticks", async () => {
  const path = newState();
  const validation = Promise.withResolvers<void>();
  let now = 0;
  let checks = 0;
  let reads = 0;
  const sync = createSessionLabelSync(endpoint, {
    path,
    now: () => now,
    verifyState: () => {
      checks++;
      now += 10_000;
      return validation.promise;
    },
    readPage: async () => {
      reads++;
      return [row()];
    },
    send: async () => accepted(),
  });
  expect(await sync()).toMatchObject({ sent: 0, timedOut: true });
  expect(reads).toBe(0);
  validation.resolve();
  expect(await sync()).toMatchObject({ sent: 1, timedOut: false });
  expect(await sync()).toMatchObject({ sent: 0, timedOut: false });
  expect(checks).toBe(1);
  expect(reads).toBe(2);
});

test("stops labeling after an external change to the attribution database", async () => {
  const path = newState();
  let reads = 0;
  const sync = createSessionLabelSync(endpoint, {
    path,
    readPage: async () => {
      reads++;
      return [row()];
    },
    send: async () => accepted(),
  });
  expect(await sync()).toMatchObject({ sent: 1 });
  writeFileSync(path, "not SQLite");
  const result = await sync();
  expect(result).toMatchObject({ sent: 0 });
  expect("error" in result).toBe(true);
  expect(reads).toBe(1);
});

test("rejects a valid replacement file while the runner is active", async () => {
  const path = newState();
  let reads = 0;
  const sync = createSessionLabelSync(endpoint, {
    path,
    readPage: async () => {
      reads++;
      return [row()];
    },
    send: async () => accepted(),
  });
  expect(await sync()).toMatchObject({ sent: 1 });
  renameSync(newState(), path);
  expect(await sync()).toMatchObject({
    sent: 0, error: "AgentsView label state changed outside the runner. Reconcile the state and restart the runner",
  });
  expect(reads).toBe(1);
});

test("stays stopped after a backup overwrites the file during a PATCH", async () => {
  const path = newState();
  const original = readFileSync(path);
  const error = "AgentsView label state changed outside the runner. Reconcile the state and restart the runner";
  let reads = 0;
  const sync = createSessionLabelSync(endpoint, {
    path,
    readPage: async () => {
      reads++;
      return [row(1, { branch: `factory/FAC-61-a${reads}` })];
    },
    send: async () => {
      writeFileSync(path, original);
      return accepted();
    },
  });
  expect(await sync()).toMatchObject({ sent: 1, error });
  expect(await sync()).toMatchObject({ sent: 0, error });
  expect(reads).toBe(1);
});

test("rejects a same-file restore after the receipt runs out of time", async () => {
  const path = newState();
  const backup = readFileSync(path);
  let clock = 0;
  let attempt = 1;
  const bodies: unknown[] = [];
  const sync = createSessionLabelSync(endpoint, {
    path,
    now: () => clock,
    readPage: async () => [row(1, { branch: `factory/FAC-61-a${attempt}` })],
    send: async (_url, { body }) => {
      bodies.push(body);
      if (attempt === 1) clock = 10_000;
      return accepted();
    },
  });
  expect(await sync()).toMatchObject({ sent: 1, timedOut: true });
  writeFileSync(path, backup);
  attempt = 2;
  expect(await sync()).toMatchObject({ sent: 0 });
  expect(bodies).toEqual(['{"add":["mf.job=FAC-61","mf.attempt=1"]}']);
});

test("refuses a WAL attribution database before reading candidates", async () => {
  const path = newState();
  const db = new Database(path, { create: false });
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    db.query("INSERT INTO attributions (session_id, job, attempt) VALUES (?, ?, ?)").run(root(1), "FAC-61", 1);
    let reads = 0;
    const sync = createSessionLabelSync(endpoint, {
      path,
      readPage: async () => {
        reads++;
        return [];
      },
    });
    expect(await sync()).toMatchObject({ sent: 0, error: "AgentsView label state requires DELETE journal mode" });
    expect(reads).toBe(0);
  } finally {
    db.close();
  }
});

test("refuses to read candidates from a database with an orphaned target", async () => {
  const path = newState();
  const db = new Database(path, { create: false });
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.query("INSERT INTO targets (id, session_id) VALUES (?, ?)").run("agent-orphan", root(1));
  } finally {
    db.close();
  }
  let reads = 0;
  const sync = createSessionLabelSync(endpoint, { path, readPage: async () => (reads++, [row()]) });
  expect(await sync()).toMatchObject({ sent: 0, error: "AgentsView label state failed SQLite integrity checks" });
  expect(reads).toBe(0);
});

test("does not read or send while disabled or with missing, corrupt, or mismatched state", async () => {
  const path = unusedStatePath();
  let reads = 0;
  let sent = 0;
  const options = {
    path,
    readPage: async () => {
      reads++;
      return [row()];
    },
    send: async () => {
      sent++;
      return accepted();
    },
  };
  expect(await createSessionLabelSync(undefined, options)()).toEqual({ disabled: true });
  expect("error" in await createSessionLabelSync(endpoint, options)()).toBe(true);
  expect(reads).toBe(0);
  expect(existsSync(path)).toBe(false);
  writeFileSync(path, "not SQLite");
  expect("error" in await createSessionLabelSync(endpoint, options)()).toBe(true);
  const other = newState("http://other.invalid");
  expect(await createSessionLabelSync(endpoint, { ...options, path: other })()).toMatchObject({
    sent: 0, error: "AgentsView label state URL does not match agentsview.url",
  });
  expect(reads).toBe(0);
  expect(sent).toBe(0);
});

test("PATCH encodes the target and sends only add with the configured Origin", async () => {
  const requests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        method: request.method,
        origin: request.headers.get("origin"),
        body: await request.json(),
      });
      return Response.json({ session_found: false });
    },
  });
  try {
    const sync = createSessionLabelSync({ url: server.url.href }, {
      path: newState(server.url.origin),
      readPage: async () => [row(1, { agent_id: "id/with?space &" })],
    });
    expect(await sync()).toMatchObject({ sent: 1 });
    expect(await sync()).toMatchObject({ sent: 0 });
    expect(requests).toEqual([{
      path: "/api/v1/sessions/agent-id%2Fwith%3Fspace%20%26/labels",
      method: "PATCH",
      origin: server.url.origin,
      body: { add: ["mf.job=FAC-61", "mf.attempt=1"] },
    }]);
  } finally {
    await server.stop(true);
  }
});

test("moves past failures and a whole page of previously acknowledged targets", async () => {
  const rows = Array.from({ length: 54 }, (_, n) => row(n + 1));
  const requests: string[] = [];
  const sync = createSessionLabelSync(endpoint, {
    path: newState(),
    readPage: async ({ session }, limit) => rows.filter((item) => item.session_id > session).slice(0, limit),
    send: async (url) => {
      requests.push(url);
      return requests.length === 1 ? new Response(null, { status: 503 }) : accepted();
    },
  });
  expect(await sync()).toMatchObject({ sent: 24, failed: 1 });
  expect(await sync()).toMatchObject({ sent: 25, failed: 0 });
  expect(await sync()).toMatchObject({ sent: 4, failed: 0 });
  expect(await sync()).toMatchObject({ sent: 1, failed: 0 });
  expect(await sync()).toMatchObject({ sent: 0, failed: 0 });
  rows.push(row(55));
  expect(await sync()).toMatchObject({ sent: 1, failed: 0 });
  expect(requests.at(-1)).toBe(`${endpoint.url}/api/v1/sessions/${root(55)}/labels`);
});

test("a candidate read that misses the deadline is discarded even when it later returns", async () => {
  const path = newState();
  const original = readFileSync(path);
  let offset = 0;
  const { promise: pending, resolve: release } = Promise.withResolvers<LabelRow[]>();
  let reads = 0;
  let sends = 0;
  const sync = createSessionLabelSync(endpoint, {
    path,
    now: () => performance.now() + offset,
    verifyState: async () => { offset = 9_900; },
    readPage: () => {
      reads++;
      return pending;
    },
    send: async () => {
      sends++;
      return accepted();
    },
  });
  expect(await sync()).toMatchObject({ sent: 0, timedOut: true });
  expect(reads).toBe(1);
  release([row()]);
  await pending;
  expect(readFileSync(path)).toEqual(original);
  expect(sends).toBe(0);
  expect(await sync()).toMatchObject({ sent: 1, timedOut: false });
});

test("the candidate read and HTTP share a deadline and the next tick continues at the unprocessed target", async () => {
  let now = 0;
  const ids: string[] = [];
  const rows = [row(1), row(2)];
  const sync = createSessionLabelSync(endpoint, {
    path: newState(),
    now: () => now,
    readPage: async ({ session }) => {
      now += 7_000;
      return rows.filter((item) => item.session_id > session);
    },
    send: async (url) => {
      ids.push(new URL(url).pathname);
      if (ids.length === 1) {
        now += 3_000;
        throw new Error("request timed out");
      }
      return accepted();
    },
  });
  expect(await sync()).toMatchObject({ sent: 0, failed: 1, timedOut: true });
  expect(await sync()).toMatchObject({ sent: 1, failed: 0, timedOut: false });
  expect(ids).toEqual([root(1), root(2)].map((id) => `/api/v1/sessions/${id}/labels`));
});
