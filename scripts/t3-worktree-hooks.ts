import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadLimits } from "../lib/config";
import { parseBranch } from "../lib/factory";
import { json, reportingHooks } from "../lib/target-wiring";

// Invoked synchronously by T3's worktree setup action, before the first provider turn.
const project = process.env.T3CODE_PROJECT_ROOT;
const tree = process.env.T3CODE_WORKTREE_PATH;
if (!project || !tree) throw new Error("T3 project and worktree paths are required");
const projectRoot = realpathSync(project);
if (loadLimits().repos.some((repo) => existsSync(repo) && realpathSync(repo) === projectRoot)) {
  const git = (...args: string[]) => execFileSync("git", ["-C", tree, ...args], { encoding: "utf8" }).trim();
  if (parseBranch(git("branch", "--show-current"))) {
    if (realpathSync(tree) !== realpathSync(git("rev-parse", "--show-toplevel")) || realpathSync(tree) === realpathSync(project)) {
      throw new Error("Expected a separate T3 worktree");
    }
    const commonDir = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    const projectGit = execFileSync("git", ["-C", project, ...commonDir], { encoding: "utf8" }).trim();
    if (realpathSync(projectGit) !== realpathSync(git(...commonDir))) throw new Error("Worktree belongs to another repository");
    const local = ".claude/settings.local.json";
    const path = join(tree, local);
    if ([dirname(path), path].some((p) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())) {
      throw new Error("Refusing to write Claude settings through a symbolic link");
    }
    if (git("ls-files", "--", local)) throw new Error("The repository tracks Claude's local settings");
    function readSettings(file: string) {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (!stat) return {};
      if (!stat.isFile()) throw new Error("Expected a regular Claude settings file");
      return JSON.parse(readFileSync(file, "utf8"));
    }
    const settings = readSettings(path);
    const shared = join(tree, ".claude/settings.json");
    const inherited = readSettings(shared);
    const root = realpathSync(process.argv[2] ?? resolve(import.meta.dirname, ".."));
    if (!existsSync(join(root, "hooks/report.ts"))) throw new Error("Missing factory reporter");
    const content = json({ ...settings, hooks: reportingHooks(settings, root, process.execPath, inherited) });
    const exclude = git("rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
    const rules = existsSync(exclude) ? readFileSync(exclude, "utf8").split("\n") : [];
    const missing = ["/" + local, "/" + local + ".marshal-*"].filter((rule) => !rules.includes(rule));
    if (missing.length) {
      mkdirSync(dirname(exclude), { recursive: true });
      appendFileSync(exclude, "\n" + missing.join("\n") + "\n");
    }
    const staging = local + ".marshal-" + crypto.randomUUID();
    git("check-ignore", "-q", "--", local);
    git("check-ignore", "-q", "--", staging);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = join(tree, staging);
    try {
      writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
