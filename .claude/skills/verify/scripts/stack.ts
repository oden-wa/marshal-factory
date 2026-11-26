#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Client } from "pg";
import { REPO, STATE_FILE, STATE_DIR, VERIFY_HOME, isOurs, readState, servesPort, startTime, withLock, type StackState } from "./paths";

const EXPIRES_AFTER_MS = 2 * 60 * 60 * 1000;

const sh = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { cwd: REPO, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

function projectId(): string {
  if (process.env.NEON_PROJECT_ID) return process.env.NEON_PROJECT_ID;
  const common = resolve(REPO, sh("git", ["rev-parse", "--git-common-dir"]).trim());
  for (const file of [join(REPO, ".neon"), join(dirname(common), ".neon")]) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).projectId;
  }
  throw new Error("no Neon project: set NEON_PROJECT_ID or run `neon set-context` in the main checkout");
}

const neon = (project: string, ...args: string[]) => sh("neon", [...args, "--project-id", project]);

// Holds the branch connection strings and the cookie secret.
const save = (state: StackState) => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

async function httpStatus(url: string): Promise<number | null> {
  try {
    return (await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) })).status;
  } catch {
    return null;
  }
}

async function up() {
  if (!startTime(process.pid)) throw new Error("stack.ts needs Linux /proc to identify and stop the panel it starts");
  const existing = readState();
  if (existing && isOurs(existing)) {
    console.log(`already up: ${existing.baseUrl} (branch ${existing.branchName}); run doctor, or down first`);
    return;
  }
  // Overwriting the state would orphan its branch, a copy of production data, until it expires.
  if (existing) throw new Error(`a stack from an earlier run is left (branch ${existing.branchName}); run \`stack.ts down\` first`);
  // drizzle.config.ts loads .env.local, which points at production in the main checkout.
  if (existsSync(join(REPO, ".env.local"))) {
    throw new Error(`${REPO}/.env.local exists and points the migration at production; run from a worktree without it`);
  }
  const port = Number(process.env.VERIFY_PORT ?? 3007);
  const baseUrl = `http://localhost:${port}`;
  if ((await httpStatus(baseUrl)) !== null) throw new Error(`${baseUrl} already answers; it is not ours, pick VERIFY_PORT`);

  const project = projectId();
  const name = `verify-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const created = JSON.parse(
    neon(project, "branches", "create", "--name", name, "--parent", "main", "--expires-at", new Date(Date.now() + EXPIRES_AFTER_MS).toISOString(), "--output", "json"),
  );
  const branchId: string = created.branch.id;
  const endpointId: string = created.endpoints[0].id;
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  const ownerPassword = `verify-${randomBytes(12).toString("base64url")}`;
  // Per stack, so it never matches an account copied from main.
  const ownerEmail = `verify-owner-${randomBytes(6).toString("hex")}@example.com`;
  // Written before anything else can fail, so `down` can always delete the branch.
  const state: StackState = { project, branchId, branchName: name, endpointId, baseUrl, port, pid: 0, pidStart: "", ownerEmail, ownerPassword, env: {} };
  save(state);
  console.log(`created branch ${name} (${branchId}), expires in 2 h`);

  const pooled = neon(project, "connection-string", branchId, "--pooled").trim();
  const direct = neon(project, "connection-string", branchId).trim();
  // Checked before the migration and the owner update write anything.
  if (!onEndpoint(pooled, state.endpointId) || !onEndpoint(direct, state.endpointId)) {
    throw new Error(`the branch connection strings do not point at ${state.endpointId}`);
  }
  const authBase = /Base URL:\s+(\S+)/.exec(neon(project, "neon-auth", "status", "--branch", branchId))?.[1];
  if (!authBase) throw new Error("the branch has no Neon Auth base URL");

  const env: Record<string, string> = {
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
    DATABASE_URL: pooled,
    DATABASE_URL_UNPOOLED: direct,
    NEON_AUTH_BASE_URL: authBase,
    NEON_AUTH_COOKIE_SECRET: randomBytes(32).toString("base64"),
    FACTORY_OWNER_EMAILS: ownerEmail,
    // Turns Realtime off (next.config.ts); the branch has no Realtime config.
    VERCEL_ENV: "preview",
    // forbidInTest (lib/test-mode.ts) makes Linear, GitHub, T3 and Modal calls throw instead of reaching production.
    FACTORY_TEST_BRANCH_ID: branchId,
    FACTORY_TEST_ENDPOINT_ID: endpointId,
  };
  state.env = env;
  save(state);

  console.log("migrating the branch to this checkout's schema");
  execFileSync("bunx", ["drizzle-kit", "migrate"], { cwd: REPO, env, stdio: "inherit" });

  console.log("creating the owner account");
  neon(project, "neon-auth", "domain", "add", baseUrl, "--branch", branchId);
  // Sign-up is open only while the owner is created; the hosted auth API is reachable from outside this machine.
  neon(project, "neon-auth", "config", "email-password", "update", "--branch", branchId,
    "--disable-sign-up", "false", "--require-email-verification", "false", "--send-verification-email-on-sign-up", "false");
  try {
    const signUp = await fetch(`${authBase}/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword, name: "Verify Owner" }),
    });
    if (!signUp.ok) throw new Error(`owner sign-up failed: ${signUp.status} ${await signUp.text()}`);
  } finally {
    neon(project, "neon-auth", "config", "email-password", "update", "--branch", branchId, "--disable-sign-up", "true");
  }
  // isOwner (lib/auth/owner.ts) also requires a verified address; no mail is sent, so mark it here.
  const client = new Client({ connectionString: direct.replace("sslmode=require", "sslmode=verify-full") });
  await client.connect();
  await client.query(`update neon_auth."user" set "emailVerified" = true where email = $1`, [ownerEmail]);
  await client.end();

  const log = join(STATE_DIR, "next-dev.log");
  // The branch is a copy of production data, so the panel listens on loopback only.
  const child = spawn("bunx", ["next", "dev", "-H", "localhost", "-p", String(port)], {
    cwd: REPO,
    env,
    detached: true,
    stdio: ["ignore", openSync(log, "w"), openSync(log, "a")],
  });
  child.unref();
  state.pid = child.pid!;
  state.pidStart = startTime(state.pid) ?? "";
  save(state);
  console.log(`next dev pid ${state.pid}, log ${log}`);

  // Ready means the sign-in page renders, which compiles the app shell and reaches Neon Auth.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if ((await httpStatus(`${baseUrl}/auth/sign-in`)) === 200 && servesPort(state)) {
      console.log(`ready: ${baseUrl}`);
      return;
    }
    if (!isOurs(state)) throw new Error(`next dev exited; see ${log}`);
    await Bun.sleep(1000);
  }
  throw new Error(`the panel did not answer within 3 minutes; see ${log}`);
}

async function doctor() {
  const state = readState();
  if (!state) throw new Error("no stack: run `stack.ts up`");
  const checks: [string, boolean, string][] = [];
  checks.push(["next dev process", isOurs(state), `pid ${state.pid}`]);
  checks.push(["serves the port", servesPort(state), `${state.baseUrl} answered by pgid ${state.pid}`]);
  const signIn = await httpStatus(`${state.baseUrl}/auth/sign-in`);
  checks.push(["sign-in page", signIn === 200, `${state.baseUrl}/auth/sign-in -> ${signIn}`]);
  const root = await httpStatus(`${state.baseUrl}/`);
  checks.push(["auth gate", root === 307 || root === 302, `/ without a session -> ${root} (redirect to sign-in)`]);
  let branchOk = false;
  try {
    branchOk = JSON.parse(neon(state.project, "branches", "get", state.branchId, "--output", "json")).id === state.branchId;
  } catch {}
  checks.push(["neon branch", branchOk, `${state.branchName} (${state.branchId})`]);
  checks.push(["points at the branch", onEndpoint(state.env.DATABASE_URL, state.endpointId) && onEndpoint(state.env.DATABASE_URL_UNPOOLED, state.endpointId), `endpoint ${state.endpointId}`]);
  for (const [name, ok, detail] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  if (checks.some(([, ok]) => !ok)) process.exit(1);
}

function down() {
  const state = readState();
  if (!state) {
    console.log("no stack recorded; nothing to stop");
    return;
  }
  if (isOurs(state)) {
    // Detached at launch, so the pid is a process group: this stops next dev and its workers, nothing else.
    try {
      process.kill(-state.pid, "SIGTERM");
    } catch {}
    console.log(`stopped next dev (pgid ${state.pid})`);
  }
  // The CLI exits 0 for a branch that is already gone, so a failure here means it still exists; keep the state to retry.
  neon(state.project, "branches", "delete", state.branchId, "--output", "json");
  console.log(`deleted branch ${state.branchName}`);
  rmSync(STATE_FILE);
  console.log(`evidence kept under ${join(VERIFY_HOME, "evidence")}`);
}

function printEnv() {
  const state = readState();
  if (!state) throw new Error("no stack: run `stack.ts up`");
  // An empty or foreign env would leave the caller's own DATABASE_URL, possibly production, in effect.
  for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
    if (!onEndpoint(state.env[key], state.endpointId)) throw new Error(`stack has no ${key} on ${state.endpointId}: run \`stack.ts down\` and \`up\` again`);
  }
  for (const [key, value] of Object.entries(state.env)) {
    if (key === "PATH" || key === "HOME") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`not a shell variable name: ${key}`);
    console.log(`export ${key}='${value.replaceAll("'", `'\\''`)}'`);
  }
}

const KNOWN_PARAMS = new Set(["sslmode", "channel_binding"]);

/** A Neon Postgres URL whose host is the branch endpoint (direct or pooled), with no parameter that could redirect it. */
function onEndpoint(value: string | undefined, endpointId: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const [label, ...domain] = url.hostname.split(".");
    return (
      (url.protocol === "postgresql:" || url.protocol === "postgres:") &&
      (label === endpointId || label === `${endpointId}-pooler`) &&
      `.${domain.join(".")}`.endsWith(".neon.tech") &&
      [...url.searchParams.keys()].every((name) => KNOWN_PARAMS.has(name))
    );
  } catch {
    return false;
  }
}

const command = process.argv[2];
if (command === "up") await withLock(up);
else if (command === "doctor") await doctor();
else if (command === "down") await withLock(down);
else if (command === "env") printEnv();
else {
  console.error("usage: stack.ts up | doctor | env | down");
  process.exit(2);
}
