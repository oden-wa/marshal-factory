import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LabelRow } from "../lib/agentsview-labels";
import { createSessionLabelSync } from "./agentsview-labels";

declare const Bun: {
  serve(options: { hostname: string; port: number; fetch(request: Request): Response | Promise<Response> }):
    { url: URL; stop(closeActiveConnections: boolean): Promise<void> };
};

const endpoint = { url: "http://agentsview.invalid:8090" };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newState() {
  const dir = mkdtempSync(join(tmpdir(), "marshal-label-test-"));
  dirs.push(dir);
  const path = join(dir, "agentsview-labels.sqlite");
  writeFileSync(path, "", { flag: "wx" });
  return path;
}

const root = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const row = (n = 1, rest: Partial<LabelRow> = {}): LabelRow => ({
  session_id: root(n), job_key: "FAC-61", branch: "factory/FAC-61", agent_id: null, ...rest,
});
const accepted = () => new Response(null, { status: 204 });

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

test("does not send while disabled or with missing, corrupt, or mismatched state", async () => {
  const path = newState();
  rmSync(path);
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
  expect(sent).toBe(0);
  writeFileSync(path, "");
  const initialized = createSessionLabelSync(endpoint, options);
  expect(await initialized()).toMatchObject({ sent: 1 });
  expect(await createSessionLabelSync({ url: "http://other.invalid" }, options)()).toMatchObject({
    sent: 0, error: "AgentsView label state URL does not match agentsview.url",
  });
  writeFileSync(path, "");
  expect(await initialized()).toMatchObject({ sent: 0, error: "AgentsView label state is missing or empty" });
  expect(sent).toBe(1);
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
      path: newState(),
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
  let firstTime = true;
  const { promise: pending, resolve: release } = Promise.withResolvers<LabelRow[]>();
  let sends = 0;
  const sync = createSessionLabelSync(endpoint, {
    path,
    now: () => {
      const offset = firstTime ? 0 : 9_950;
      firstTime = false;
      return performance.now() + offset;
    },
    readPage: () => pending,
    send: async () => {
      sends++;
      return accepted();
    },
  });
  expect(await sync()).toMatchObject({ sent: 0, timedOut: true });
  release([row()]);
  await pending;
  expect(statSync(path).size).toBe(0);
  expect(sends).toBe(0);
  expect(await sync()).toMatchObject({ sent: 1, timedOut: false });
});

test("the candidate read and HTTP share a deadline and the next tick continues at the unprocessed target", async () => {
  let offset = 0;
  const ids: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      ids.push(new URL(request.url).pathname);
      if (ids.length === 1) await new Promise((resolve) => setTimeout(resolve, 400));
      return accepted();
    },
  });
  try {
    const rows = [row(1), row(2)];
    let firstPage = true;
    const sync = createSessionLabelSync({ url: server.url.href }, {
      path: newState(),
      now: () => performance.now() + offset,
      readPage: async ({ session }) => {
        if (firstPage) offset += 9_800;
        firstPage = false;
        return rows.filter((item) => item.session_id > session);
      },
    });
    expect(await sync()).toMatchObject({ sent: 0, failed: 1, timedOut: true });
    expect(await sync()).toMatchObject({ sent: 1, failed: 0, timedOut: false });
    expect(ids).toEqual([root(1), root(2)].map((id) => `/api/v1/sessions/${id}/labels`));
  } finally {
    await server.stop(true);
  }
});
