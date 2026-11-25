import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_PATH } from "./config";
import { json, withHooks, withServer, type Json } from "./target-wiring";

export type InstallLog = (line: string) => void;

const readJson = (path: string): Json => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Json) : {});

function write(path: string, content: string, log: InstallLog) {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    log(`unchanged ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  log(`wrote     ${path}`);
}

export type FactoryRepoAdd = "added" | "present" | "missing";

export function addRepoToFactoryConfig(repo: string, { configPath = CONFIG_PATH, log = console.log }: { configPath?: string; log?: InstallLog } = {}): FactoryRepoAdd {
  if (!existsSync(configPath)) {
    log(`skipped   factory.repos: ${configPath} does not exist yet; add ${repo} there by hand`);
    return "missing";
  }
  const config = readJson(configPath);
  const factory = (config.factory as Json | undefined) ?? {};
  const repos = (factory.repos as string[] | undefined) ?? [];
  if (repos.includes(repo)) return "present";
  factory.repos = [...repos, repo];
  writeFileSync(configPath, json({ ...config, factory }));
  chmodSync(configPath, 0o600);
  log(`added     ${repo} to factory.repos in ${configPath}`);
  return "added";
}

export function wireTarget(target: string, root: string, log: InstallLog = console.log) {
  const repo = resolve(target);
  const factoryRoot = root.replace(/\/$/, "");
  const settingsPath = join(repo, ".claude/settings.json");
  write(settingsPath, json(withHooks(readJson(settingsPath), factoryRoot)), log);
  const mcpPath = join(repo, ".mcp.json");
  write(mcpPath, json(withServer(readJson(mcpPath), factoryRoot)), log);
  write(join(repo, ".agents/playbooks/factory.md"), readFileSync(join(factoryRoot, "playbooks/factory.md"), "utf8"), log);

  // Claude Code puts isolated subagents in .claude/worktrees/; linting them breaks the repo's lint.
  const eslintConfig = ["eslint.config.mjs", "eslint.config.js", "eslint.config.ts"].map((name) => join(repo, name)).find(existsSync);
  if (eslintConfig) {
    const text = readFileSync(eslintConfig, "utf8");
    if (text.includes(".claude/")) log(`unchanged ${eslintConfig}`);
    else if (text.includes("globalIgnores([")) write(eslintConfig, text.replace("globalIgnores([", 'globalIgnores([\n    ".claude/**",'), log);
    else log(`skipped   ${eslintConfig}: add ".claude/**" to its ignores by hand`);
  }
}

export function installTarget(target: string, root: string, log: InstallLog = console.log) {
  const repo = resolve(target);
  addRepoToFactoryConfig(repo, { log });
  wireTarget(repo, root, log);
}
