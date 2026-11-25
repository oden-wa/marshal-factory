import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withHooks } from "../lib/target-wiring";

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
    writeFileSync(config, JSON.stringify({factory: {repos: [project]}}));
    const setup = (path: string) => execFileSync(process.execPath, [join(import.meta.dirname, "t3-worktree-hooks.ts")], {
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
    const report = withHooks({}, "/factory").hooks as Record<string, unknown>;
    mkdirSync(join(tree, ".claude"));
    writeFileSync(join(tree, ".claude/settings.json"), JSON.stringify({hooks: {SessionStart: report.SessionStart}}));
    setup(tree);
    const first = readFileSync(local, "utf8");
    assert.equal(JSON.parse(first).hooks.SessionStart.length, 0);
    assert.equal(JSON.parse(first).hooks.SubagentStop.length, 1);
    setup(tree);
    assert.equal(readFileSync(local, "utf8"), first);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
