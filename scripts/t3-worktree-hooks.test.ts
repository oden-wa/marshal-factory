import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportingHooks, withHooks } from "../lib/target-wiring";

test("T3 installs only missing hooks in an ignored settings file in its own worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "marshal-t3-hooks-"));
  try {
    const project = join(dir, "project");
    const tree = join(dir, "tree");
    const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
    git("init", "-q", project);
    git("-C", project, "-c", "user.name=test", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-qm", "fixture");
    git("-C", project, "worktree", "add", "-qb", "factory/FAC-1", tree);
    const config = join(dir, "config.json");
    symlinkSync(project, join(dir, "alias"));
    writeFileSync(config, JSON.stringify({factory: {repos: [join(dir, "alias")]}}));
    writeFileSync(join(tree, "bunfig.toml"), "[invalid");
    const setup = (path: string) => execFileSync(join(import.meta.dirname, "t3-worktree-hooks.sh"), [process.execPath], {
      cwd: path,
      env: {...process.env, MARSHAL_FACTORY_CONFIG: config, T3CODE_PROJECT_ROOT: project, T3CODE_WORKTREE_PATH: path}, stdio: "pipe",
    });
    const foreign = join(dir, "foreign");
    git("clone", "-q", project, foreign);
    git("-C", foreign, "checkout", "-qb", "factory/FAC-2");
    assert.throws(() => setup(foreign));
    assert.equal(existsSync(join(foreign, ".claude")), false);
    const local = join(tree, ".claude/settings.local.json");
    writeFileSync(join(tree, ".gitignore"), "!/.claude/settings.local.json\n");
    assert.throws(() => setup(tree));
    assert.equal(existsSync(local), false);
    rmSync(join(tree, ".gitignore"));
    const report = withHooks({}, join(import.meta.dirname, "..")).hooks as Record<string, unknown>;
    mkdirSync(join(tree, ".claude"));
    writeFileSync(join(tree, ".claude/settings.json"), JSON.stringify({hooks: {SessionStart: report.SessionStart}}));
    setup(tree);
    const first = readFileSync(local, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(first)), ["hooks"]);
    assert.equal(JSON.parse(first).hooks.SessionStart.length, 0);
    assert.equal(JSON.parse(first).hooks.SubagentStop.length, 1);
    setup(tree);
    assert.equal(readFileSync(local, "utf8"), first);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test("legacy local commands are replaced and equivalent shared matchers are inherited", () => {
  const root = "/factory $archive";
  const hook = (command: string) => ({type: "command", command});
  const local = {hooks: {PostToolUse: [{hooks: [
    hook(`'/old/bin/bun' "${root}/hooks/report.ts"`), hook("node ./hooks/report.ts"),
  ]}]}};
  const command = 'bun "/factory \\$archive/hooks/report.ts"';
  for (const matcher of ["*", ".*"]) {
    const shared = {hooks: {PostToolUse: [{matcher, hooks: [hook(command)]}]}};
    const hooks = reportingHooks(local, root, "/new/bin/bun", shared);
    assert.deepEqual(hooks.PostToolUse, [{hooks: [hook("node ./hooks/report.ts")]}]);
  }
  const outdated = {hooks: {PostToolUse: [{hooks: [hook(`bun "${root}/hooks/report.ts"`)]}]}};
  assert.throws(() => reportingHooks({}, root, "/new/bin/bun", outdated), /Conflicting/);
});
