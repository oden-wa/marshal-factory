import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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

function reporterPrefix(root: string) {
  return `export FACTORY_HOOK_CWD="$PWD" && cd ${shellPath(join(root, "."))} && exec `;
}

function reporterCommand(root: string, bun: string) {
  return `${reporterPrefix(root)}${bun === "bun" ? bun : shellPath(bun)} ${shellPath(join(root, "hooks/report.ts"))}`;
}

function hooksFor(root: string, bun: string): Record<string, HookEntry[]> {
  const reporter = { type: "command", command: reporterCommand(root, bun), async: true, timeout: 20 };
  return {
    SessionStart: [{ hooks: [reporter] }],
    PreToolUse: [{ matcher: "Agent", hooks: [reporter] }],
    PostToolUse: [{ hooks: [reporter] }],
    SubagentStop: [{ hooks: [reporter] }],
    Stop: [{ hooks: [reporter] }],
    SessionEnd: [{ hooks: [reporter] }],
  };
}

export function reportingHooks(settings: Json, factoryRoot: string, bun: string, shared: Json = {}) {
  const root = join(factoryRoot, ".");
  if (!isAbsolute(root)) throw new Error("Factory checkout must be an absolute path");
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]>) ?? {}) };
  if ((settings.disableAllHooks ?? shared.disableAllHooks) === true) throw new Error("Claude reporting disabled by disableAllHooks");
  // Earlier installers quoted the absolute Bun binary with either kind of quote.
  // Match the complete invocation and exact reporter path, including legacy path quoting.
  function generated(command: string, script: string, checkout = root) {
    const prefix = reporterPrefix(checkout);
    const wrapped = script === "report.ts" && command.startsWith(prefix);
    if (wrapped) command = command.slice(prefix.length);
    const path = `${checkout}/hooks/${script}`;
    for (const arg of new Set([shellPath(path), '"' + path + '"'])) {
      if (!command.endsWith(" " + arg)) continue;
      const executable = command.slice(0, -arg.length - 1);
      if (/^"\/(?:\\["\\$`]|[^"\\$`])*"$/.test(executable)) return true;
      if (executable === "bun" || /^'\/[^']*'$/.test(executable) || executable === shellPath(bun)) return true;
    }
    return false;
  }
  function referencedCheckout(command: string) {
    const argument = /"((?:\\.|[^"\\])+)\/hooks\/(report|budget)\.ts"$/.exec(command);
    const alias = argument?.[1]?.replace(/\\(["\\$`])/g, "$1");
    let trusted = root;
    if (alias && alias !== root && alias.startsWith("/")) {
      try {
        if (realpathSync(alias) === realpathSync(root)) trusted = alias;
      } catch { /* An unrelated checkout may not exist on this host. */ }
    }
    return trusted;
  }
  const matcher = (value?: string) => value === "*" || value === ".*" ? "" : value ?? "";
  const desired = hooksFor(root, bun);
  const sharedHooks = (shared.hooks as Record<string, HookEntry[]> | undefined) ?? {};
  for (const event of new Set([...Object.keys(desired), ...Object.keys(sharedHooks), ...Object.keys(hooks)])) {
    const ours = desired[event] ?? [];
    const installed = sharedHooks[event] ?? [];

    let inherited = false;
    for (const entry of installed) {
      for (const hook of entry.hooks ?? []) {
        if (hook.type !== "command") continue;
        const trusted = referencedCheckout(hook.command);
        if (generated(hook.command, "budget.ts", trusted)) throw new Error(`Remove the retired shared budget hook for ${event}`);
        const safe = hook.command === reporterCommand(trusted, bun) || hook.command === reporterCommand(trusted, "bun");
        if (!generated(hook.command, "report.ts", trusted)) continue;
        if (!ours.length || trusted !== root || !safe || matcher(entry.matcher) !== matcher(ours[0]?.matcher) ||
            inherited) {
          throw new Error(`Conflicting shared reporter for ${event}`);
        }
        inherited = true;
      }
    }
    const local = (hooks[event] ?? []).flatMap((entry) => {
      const other = entry.hooks.filter((hook) => {
        if (hook.type !== "command") return true;
        const checkout = referencedCheckout(hook.command);
        return !generated(hook.command, "report.ts", checkout) && !generated(hook.command, "budget.ts", checkout);
      });
      return other.length ? [{ ...entry, hooks: other }] : [];
    });
    if (ours.length || hooks[event]) hooks[event] = inherited ? local : [...local, ...ours];
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
