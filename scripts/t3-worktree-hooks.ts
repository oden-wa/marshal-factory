import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadLimits } from "../lib/config";
import { parseBranch } from "../lib/factory";
import { json, withHooks } from "../lib/target-wiring";

// Invoked synchronously by T3's worktree setup action, before the first provider turn.
const project = process.env.T3CODE_PROJECT_ROOT;
const tree = process.env.T3CODE_WORKTREE_PATH;
if (!project || !tree) throw new Error("T3 project and worktree paths are required");
if (loadLimits().repos.some((repo) => resolve(repo) === resolve(project))) {
  const git = (...args: string[]) => execFileSync("git", ["-C", tree, ...args], { encoding: "utf8" }).trim();
  if (parseBranch(git("branch", "--show-current"))) {
    if (realpathSync(tree) !== realpathSync(git("rev-parse", "--show-toplevel")) || realpathSync(tree) === realpathSync(project)) {
      throw new Error("Expected a separate T3 worktree");
    }
    const local = ".claude/settings.local.json";
    const path = join(tree, local);
    if ([dirname(path), path].some((p) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())) {
      throw new Error("Refusing to write Claude settings through a symbolic link");
    }
    if (git("ls-files", "--", local)) throw new Error("The repository tracks Claude's local settings");
    const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    const content = json(withHooks(settings, resolve(import.meta.dirname, ".."), "'" + process.execPath.replaceAll("'", "'\\''") + "'"));
    const exclude = git("rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
    const pattern = "/" + local;
    if (!existsSync(exclude) || !readFileSync(exclude, "utf8").split("\n").includes(pattern)) {
      mkdirSync(dirname(exclude), { recursive: true });
      appendFileSync(exclude, "\n" + pattern + "\n");
    }
    mkdirSync(dirname(path), { recursive: true });
    const temporary = path + "." + process.pid;
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  }
}
