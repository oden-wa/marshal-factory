import "./test-guard";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";

const { db } = await import("../db/client");
const { repoSettings } = await import("../db/schema");
const { config } = await import("../runner/config");
const { localCheckoutRuntime, ensureT3Project, prepareRepoCheckout } = await import("../runner/local-checkout");
const { localHost } = await import("../lib/host");
const { addRepoToFactoryConfig, wireTarget } = await import("../lib/install-target");
const { parseDetail } = await import("../lib/onboarding");

const stamp = Date.now();
const NS = `test-local-${stamp}`;
const root = mkdtempSync(join(tmpdir(), "local-checkout-"));
const original = {
  repos: [...config.factory.repos],
  checkoutRoot: config.factory.checkoutRoot,
  clone: localCheckoutRuntime.clone,
  wire: localCheckoutRuntime.wire,
  addRepo: localCheckoutRuntime.addRepo,
  ensureProject: localCheckoutRuntime.ensureProject,
  machine: localCheckoutRuntime.machine,
};

const initRepo = (path: string, repo: string) => {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "remote", "add", "origin", `https://github.com/${repo}.git`]);
};
const insert = (repo: string) =>
  db.insert(repoSettings).values({
    repo,
    enabled: true,
    execution: "local",
    onboarding_detail: { localCheckout: { state: "preparing", requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } },
    updated_at: new Date(),
    updated_by: "test",
  });
const detail = async (repo: string) => parseDetail((await db.select().from(repoSettings).where(eq(repoSettings.repo, repo)))[0]?.onboarding_detail).localCheckout;

try {
  config.factory.repos = [];
  config.factory.checkoutRoot = root;
  const clones: string[] = [];
  const wired: string[] = [];
  const added: string[] = [];
  const projects: string[] = [];
  localCheckoutRuntime.clone = async (repo, path) => {
    clones.push(`${repo} ${path}`);
    initRepo(path, repo);
  };
  localCheckoutRuntime.wire = (path) => void wired.push(path);
  localCheckoutRuntime.addRepo = async (path) => void added.push(path);
  localCheckoutRuntime.ensureProject = async (path) => void projects.push(path);
  localCheckoutRuntime.machine = async () => ({ id: "test-machine", name: "test-runner", idFrom: "config" });

  const auto = `${NS}/auto`;
  await insert(auto);
  const prepared = await prepareRepoCheckout(auto);
  const autoPath = join(root, "auto");
  assert.deepEqual([prepared.state, prepared.cloned, prepared.path], ["ready", true, autoPath]);
  assert.deepEqual(clones, [`${auto} ${autoPath}`]);
  assert.deepEqual(wired, [autoPath]);
  assert.deepEqual(added, [autoPath]);
  assert.deepEqual(projects, [autoPath], "the checkout is registered as a T3 project before it is ready");
  assert.deepEqual(config.factory.repos, [autoPath]);
  let checkout = await detail(auto);
  assert.deepEqual([checkout?.state, checkout?.machine, checkout?.path, checkout?.failure], ["ready", "test-runner", autoPath, undefined]);

  await prepareRepoCheckout(auto);
  assert.equal(clones.length, 1, "a retried intent reuses the checkout it already made");

  const firstRoot = config.factory.checkoutRoot;
  const firstClone = localCheckoutRuntime.clone;
  const firstMachine = localCheckoutRuntime.machine;
  config.factory.repos = [];
  config.factory.checkoutRoot = join(root, "another-machine");
  localCheckoutRuntime.clone = async () => {
    throw new Error("a completed checkout must not be retried");
  };
  localCheckoutRuntime.machine = async () => ({ id: "other-machine", name: "other-runner", idFrom: "config" });
  assert.deepEqual(await prepareRepoCheckout(auto), { repo: auto, skipped: "no pending checkout" }, "a completed checkout is not retried on another runner");
  checkout = await detail(auto);
  assert.deepEqual([checkout?.state, checkout?.machine, checkout?.failure], ["ready", "test-runner", undefined], "and the retry does not overwrite the completed state");
  config.factory.repos = [autoPath];
  config.factory.checkoutRoot = firstRoot;
  localCheckoutRuntime.clone = firstClone;
  localCheckoutRuntime.machine = firstMachine;

  const existing = `${NS}/existing`;
  const existingPath = join(root, "installed-existing");
  initRepo(existingPath, existing);
  config.factory.repos.push(existingPath);
  await insert(existing);
  const adopted = await prepareRepoCheckout(existing);
  assert.deepEqual([adopted.state, adopted.cloned, adopted.path], ["ready", false, existingPath], "a manually installed target is adopted");
  assert.equal(clones.length, 1);
  assert.deepEqual(projects, [autoPath, existingPath], "an adopted target also gets a T3 project");

  const projectless = `${NS}/projectless`;
  await insert(projectless);
  localCheckoutRuntime.ensureProject = async () => {
    throw new Error("t3 project add failed");
  };
  await assert.rejects(prepareRepoCheckout(projectless), /t3 project add failed/);
  checkout = await detail(projectless);
  assert.equal(checkout?.state, "failed");
  assert.match(checkout?.failure?.reason ?? "", /t3 project add failed/);
  localCheckoutRuntime.ensureProject = async (path) => void projects.push(path);

  const broken = `${NS}/broken`;
  await insert(broken);
  localCheckoutRuntime.clone = async () => {
    throw new Error("clone network failed");
  };
  await assert.rejects(prepareRepoCheckout(broken), /clone network failed/);
  checkout = await detail(broken);
  assert.equal(checkout?.state, "failed");
  assert.match(checkout?.failure?.reason ?? "", /clone network failed/);

  const configDir = mkdtempSync(join(tmpdir(), "factory-config-"));
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ secret: "keep", factory: { repos: [] } }));
  assert.equal(addRepoToFactoryConfig("/tmp/one", { configPath, log: () => {} }), "added");
  assert.equal(addRepoToFactoryConfig("/tmp/one", { configPath, log: () => {} }), "present");
  assert.equal(addRepoToFactoryConfig("/tmp/one", { configPath: join(configDir, "missing.json"), log: () => {} }), "missing");
  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(written.secret, "keep", "adding a repo preserves the config's secrets");
  assert.deepEqual(written.factory.repos, ["/tmp/one"]);

  const wireRepo = join(root, "wired");
  initRepo(wireRepo, `${NS}/wired`);
  wireTarget(wireRepo, resolve("."), () => {});
  assert.ok(readFileSync(join(wireRepo, ".claude/settings.json"), "utf8").includes("hooks/report.ts"));
  assert.ok(readFileSync(join(wireRepo, ".mcp.json"), "utf8").includes("factory-report"));
  assert.ok(existsSync(join(wireRepo, ".agents/playbooks/factory.md")));

  const linkedRepo = join(root, "linked");
  const outside = join(root, "outside");
  initRepo(linkedRepo, `${NS}/linked`);
  mkdirSync(outside);
  symlinkSync(outside, join(linkedRepo, ".claude"), "dir");
  assert.throws(() => wireTarget(linkedRepo, resolve("."), () => {}), /refusing to wire a symbolic link/, "a symlinked destination is refused");
  assert.equal(existsSync(join(outside, "settings.json")), false, "and nothing is written through it");


  const originalRun = localHost.run;
  const t3Calls: string[] = [];
  try {
    localHost.run = async (_command, args) => {
      const call = args.join(" ");
      t3Calls.push(call);
      if (call.startsWith("thread list")) throw new Error("No T3 Code project matches");
      if (call.startsWith("project add")) return { stdout: "", stderr: "" };
      throw new Error(`unexpected t3 call: ${call}`);
    };
    await ensureT3Project("/tmp/project-new");
    assert.deepEqual(t3Calls, ["thread list --project /tmp/project-new --json", "project add /tmp/project-new --title project-new"]);

    t3Calls.length = 0;
    localHost.run = async (_command, args) => {
      const call = args.join(" ");
      t3Calls.push(call);
      return { stdout: "[]", stderr: "" };
    };
    await ensureT3Project("/tmp/project-present");
    assert.deepEqual(t3Calls, ["thread list --project /tmp/project-present --json"], "an existing T3 project is reused");

    t3Calls.length = 0;
    let probes = 0;
    localHost.run = async (_command, args) => {
      const call = args.join(" ");
      t3Calls.push(call);
      if (call.startsWith("thread list")) {
        probes += 1;
        if (probes === 1) throw new Error("No T3 Code project matches");
        return { stdout: "[]", stderr: "" };
      }
      if (call.startsWith("project add")) throw new Error("ProjectAlreadyExistsError: An active project already exists");
      throw new Error(`unexpected t3 call: ${call}`);
    };
    await ensureT3Project("/tmp/project-race");
    assert.deepEqual(t3Calls.filter((call) => call.startsWith("project add")).length, 1, "a registration race is confirmed by probing T3");

    localHost.run = async (_command, args) => {
      const call = args.join(" ");
      if (call.startsWith("project add")) throw new Error("permission denied");
      throw new Error("No T3 Code project matches");
    };
    await assert.rejects(ensureT3Project("/tmp/project-failure"), /permission denied/, "an unconfirmed registration failure is not swallowed");
  } finally {
    localHost.run = originalRun;
  }

  console.log("local checkout regressions passed");
} finally {
  config.factory.repos = original.repos;
  config.factory.checkoutRoot = original.checkoutRoot;
  localCheckoutRuntime.clone = original.clone;
  localCheckoutRuntime.wire = original.wire;
  localCheckoutRuntime.addRepo = original.addRepo;
  localCheckoutRuntime.ensureProject = original.ensureProject;
  localCheckoutRuntime.machine = original.machine;
}
