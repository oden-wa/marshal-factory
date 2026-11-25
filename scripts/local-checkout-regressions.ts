import "./test-guard";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";

const { db } = await import("../db/client");
const { repoSettings } = await import("../db/schema");
const { config } = await import("../runner/config");
const { localCheckoutRuntime, prepareRepoCheckout } = await import("../runner/local-checkout");
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
  localCheckoutRuntime.clone = async (repo, path) => {
    clones.push(`${repo} ${path}`);
    initRepo(path, repo);
  };
  localCheckoutRuntime.wire = (path) => void wired.push(path);
  localCheckoutRuntime.addRepo = async (path) => void added.push(path);
  localCheckoutRuntime.machine = async () => ({ id: "test-machine", name: "test-runner", idFrom: "config" });

  const auto = `${NS}/auto`;
  await insert(auto);
  const prepared = await prepareRepoCheckout(auto);
  const autoPath = join(root, "auto");
  assert.deepEqual([prepared.state, prepared.cloned, prepared.path], ["ready", true, autoPath]);
  assert.deepEqual(clones, [`${auto} ${autoPath}`]);
  assert.deepEqual(wired, [autoPath]);
  assert.deepEqual(added, [autoPath]);
  assert.deepEqual(config.factory.repos, [autoPath]);
  let checkout = await detail(auto);
  assert.deepEqual([checkout?.state, checkout?.machine, checkout?.path, checkout?.failure], ["ready", "test-runner", autoPath, undefined]);

  await prepareRepoCheckout(auto);
  assert.equal(clones.length, 1, "a retried intent reuses the checkout it already made");

  const existing = `${NS}/existing`;
  const existingPath = join(root, "installed-existing");
  initRepo(existingPath, existing);
  config.factory.repos.push(existingPath);
  await insert(existing);
  const adopted = await prepareRepoCheckout(existing);
  assert.deepEqual([adopted.state, adopted.cloned, adopted.path], ["ready", false, existingPath], "a manually installed target is adopted");
  assert.equal(clones.length, 1);

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

  console.log("local checkout regressions passed");
} finally {
  config.factory.repos = original.repos;
  config.factory.checkoutRoot = original.checkoutRoot;
  localCheckoutRuntime.clone = original.clone;
  localCheckoutRuntime.wire = original.wire;
  localCheckoutRuntime.addRepo = original.addRepo;
  localCheckoutRuntime.machine = original.machine;
}
