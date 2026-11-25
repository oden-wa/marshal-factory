import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportingHooks, withHooks } from "../lib/target-wiring";

test("T3 installs only missing hooks in an ignored settings file in its own worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "marshal-t3-hooks-"));
  try {
    const project = join(dir, "project");
    const tree = join(dir, "tree ");
    const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
    git("init", "-q", project);
    git("-C", project, "-c", "user.name=test", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-qm", "fixture");
    git("-C", project, "worktree", "add", "-qb", "factory/FAC-1", tree);
    const config = join(dir, "config.json");
    symlinkSync(project, join(dir, "alias"));
    writeFileSync(config, JSON.stringify({factory: {repos: [join(dir, "alias")]}, ingestUrl: "http://127.0.0.1:1", secret: "fixture"}));
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
    const command = JSON.parse(first).hooks.PostToolUse[0].hooks[0].command;
    execFileSync("/bin/sh", ["-c", command], {
      cwd: tree, env: {...process.env, HOME: dir, MARSHAL_FACTORY_CONFIG: config, FACTORY_STATE_DIR: dir},
      input: JSON.stringify({hook_event_name: "PostToolUse", session_id: "fixture", tool_name: "mcp__factory-report__report_stage",
        tool_input: {stage: "waiting", summary: "fixture", question: "ok?"}}),
    });
    const outbox = join(dir, "outbox");
    const event = JSON.parse(readFileSync(join(outbox, readdirSync(outbox)[0]!), "utf8"));
    assert.equal(event.branch, "factory/FAC-1");
    assert.equal(event.jobKey, "FAC-1");
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
  const command = 'export FACTORY_HOOK_CWD="$PWD" && cd "/factory \\$archive" && exec bun "/factory \\$archive/hooks/report.ts"';
  for (const matcher of ["*", ".*"]) {
    const shared = {hooks: {PostToolUse: [{matcher, hooks: [hook(command)]}]}};
    const hooks = reportingHooks(local, root, "/new/bin/bun", shared);
    assert.deepEqual(hooks.PostToolUse, [{hooks: [hook("node ./hooks/report.ts")]}]);
  }
  const outdated = {hooks: {PostToolUse: [{hooks: [hook(`bun "${root}/hooks/report.ts"`)]}]}};
  assert.throws(() => reportingHooks({}, root, "/new/bin/bun", outdated), /Conflicting/);
});

test("mutable shared reporter aliases are rejected, disabled hooks and retired budget hooks are reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "marshal-reporter-alias-"));
  try {
    const root = join(import.meta.dirname, "..");
    const alias = join(dir, "factory");
    symlinkSync(root, alias);
    const shared = withHooks({}, alias);
    assert.throws(() => reportingHooks({}, root, process.execPath, shared), /Conflicting/);
    assert.throws(() => reportingHooks({}, "relative/factory", process.execPath), /absolute path/);
    assert.throws(() => reportingHooks({}, root, process.execPath, {disableAllHooks: true}), /disableAllHooks/);
    assert.doesNotThrow(() => reportingHooks({disableAllHooks: false}, root, process.execPath, {disableAllHooks: true}));
    const budget = {hooks: {UserPromptSubmit: [{hooks: [{type: "command", command: `bun "${alias}/hooks/budget.ts"`}]}]}};
    assert.throws(() => reportingHooks({}, root, process.execPath, budget), /retired shared budget/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test("Bun upgrades replace old local reporters and flag stale shared reporters", () => {
  const old = {hooks: reportingHooks({}, "/factory/", "/old/bin/bun")};
  const current = reportingHooks(old, "/factory", "/new/bin/bun");
  assert.deepEqual(current, reportingHooks({}, "/factory", "/new/bin/bun"));
  assert.throws(() => reportingHooks({}, "/factory", "/new/bin/bun", old), /Conflicting/);
  assert.equal(reportingHooks({}, "/factory", "/old/bin/bun", old).SessionStart?.length, 0);
});
