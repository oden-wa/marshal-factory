import { join } from "node:path";
import { REPORT_SERVER, REPORT_STAGE_TOOL } from "./factory";

// How a target repo reaches a factory checkout: Claude Code hooks, the factory-report MCP server.
// Pure, so the installer and the sandbox launch wire the same way from different factory roots.

export type Json = Record<string, unknown>;
type HookEntry = {
  matcher?: string;
  hooks: { type: string; command: string; async?: boolean; timeout?: number }[];
};

/** Ours, per event, in order. PostToolUse takes every tool so the reporter can send usage snapshots. */
function shellPath(path: string) {
  return '"' + path.replace(/["\\$`]/g, "\\$&") + '"';
}

function hooksFor(root: string, bun: string): Record<string, HookEntry[]> {
  const reporter = { type: "command", command: `${bun === "bun" ? bun : shellPath(bun)} ${shellPath(join(root, "hooks/report.ts"))}`, async: true, timeout: 20 };
  return {
    SessionStart: [{ hooks: [reporter] }],
    PreToolUse: [{ matcher: "Agent", hooks: [reporter] }],
    PostToolUse: [{ hooks: [reporter] }],
    SubagentStop: [{ hooks: [reporter] }],
    Stop: [{ hooks: [reporter] }],
    SessionEnd: [{ hooks: [reporter] }],
  };
}

export function reportingHooks(settings: Json, root: string, bun: string, shared: Json = {}) {
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]>) ?? {}) };
  // Earlier installers quoted the absolute Bun binary with either kind of quote.
  // Match the complete invocation and exact reporter path, including legacy path quoting.
  function generated(command: string, script: string) {
    const path = join(root, "hooks", script);
    for (const arg of new Set([shellPath(path), '"' + path + '"'])) {
      if (!command.endsWith(" " + arg)) continue;
      const executable = command.slice(0, -arg.length - 1);
      if (executable === "bun" || /^"\/[^"]*\/bun"$/.test(executable) || /^'\/[^']*\/bun'$/.test(executable) || executable === shellPath(bun)) return true;
    }
    return false;
  }
  const matcher = (value?: string) => value === "*" || value === ".*" ? "" : value ?? "";
  for (const [event, ours] of Object.entries(hooksFor(root, bun))) {
    const installed = (shared.hooks as Record<string, HookEntry[]> | undefined)?.[event] ?? [];
    const legacy = `bun ${shellPath(join(root, "hooks/report.ts"))}`;
    let inherited = false;
    for (const entry of installed) {
      for (const hook of entry.hooks ?? []) {
        if (hook.type !== "command" || !generated(hook.command, "report.ts")) continue;
        if ((hook.command !== legacy && hook.command !== ours[0]?.hooks[0]?.command) || matcher(entry.matcher) !== matcher(ours[0]?.matcher) ||
            inherited) {
          throw new Error(`Conflicting shared reporter for ${event}`);
        }
        inherited = true;
      }
    }
    const local = (hooks[event] ?? []).flatMap((entry) => {
      const other = entry.hooks.filter((hook) => hook.type !== "command" || (!generated(hook.command, "report.ts") && !generated(hook.command, "budget.ts")));
      return other.length ? [{ ...entry, hooks: other }] : [];
    });
    hooks[event] = inherited ? local : [...local, ...ours];
  }
  return hooks;
}

export function withHooks(settings: Json, root: string): Json {
  const hooks = reportingHooks(settings, root, "bun");
  const permissions = (settings.permissions as Json) ?? {};
  const allow = new Set([...((permissions.allow as string[]) ?? []), REPORT_STAGE_TOOL]);
  const enabled = new Set([...((settings.enabledMcpjsonServers as string[]) ?? []), REPORT_SERVER]);
  return {
    ...settings,
    enabledMcpjsonServers: [...enabled],
    permissions: { ...permissions, allow: [...allow] },
    hooks,
  };
}

export const reportServer = (root: string) => ({ command: "bun", args: [join(root, "mcp/factory-report.ts")] });

/** Claude Code's hooks report its stages, so its server only validates. */
export function withServer(mcp: Json, root: string): Json {
  return { ...mcp, mcpServers: { ...((mcp.mcpServers as Json) ?? {}), [REPORT_SERVER]: { ...reportServer(root), env: { FACTORY_REPORTER: "hook" } } } };
}

/** The factory checkouts a repo's committed wiring points at, read from its settings and .mcp.json text. */
export function wiredRoots(...files: (string | null)[]) {
  const roots = new Set<string>();
  for (const text of files) {
    for (const match of (text ?? "").matchAll(/(\/[^"\s]*?)\/(?:hooks\/(?:report|budget)|mcp\/factory-report)\.ts/g)) roots.add(match[1]!);
  }
  return [...roots];
}

export const json = (value: Json) => `${JSON.stringify(value, null, 2)}\n`;
