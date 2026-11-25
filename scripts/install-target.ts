import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installTarget } from "../lib/install-target";

// Wires a target repo to this checkout: hooks, the factory-report MCP server, the playbook.
// Re-running converges on the same files and merges with what the repo already has.

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const target = process.argv[2];
if (!target || !existsSync(join(target, ".git"))) {
  console.error("usage: bun scripts/install-target.ts <path to a git repo>");
  process.exit(1);
}

installTarget(target, root);
