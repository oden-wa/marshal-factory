import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { RUNNER_LOG_PATH } from "../lib/rollout";

// Installs the runner as a background user service (launchd on macOS, systemd --user on Linux):
// started on boot/login, restarted when it exits, logging to RUNNER_LOG_PATH.
// Re-running with nothing changed leaves it alone.
//   bun scripts/install-runner.ts [--uninstall]

export const LABEL = "com.marshal-factory.runner";
export const SYSTEMD_UNIT = "marshal-factory-runner.service";
const root = join(import.meta.dirname, "..");
const logPath = RUNNER_LOG_PATH;

const which = (bin: string) => execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim();
const whichOptional = (bin: string) => {
  try {
    return which(bin);
  } catch {
    return undefined;
  }
};

function resolvePaths() {
  const bun = which("bun");
  const git = which("git");
  const extras = ["gh", "claude", "codex", "uv"]
    .map(whichOptional)
    .filter((p): p is string => Boolean(p));
  const t3 =
    process.env.T3CODE_CLI_PATH ??
    [join(homedir(), ".t3/bin/t3"), join(homedir(), ".local/bin/t3")].find(existsSync) ??
    which("t3");
  const path = [
    ...new Set([
      ...[bun, git, t3, ...extras].map(dirname),
      join(homedir(), ".local/bin"),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ].join(":");
  return { bun, t3, path };
}

function runLinux(uninstall: boolean) {
  const uid = userInfo().uid;
  const unitPath = join(homedir(), ".config/systemd/user", SYSTEMD_UNIT);
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
  };
  const systemctl = (...args: string[]) =>
    execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: "pipe", env });
  const isActive = () => {
    try {
      return systemctl("is-active", SYSTEMD_UNIT).trim() === "active";
    } catch {
      return false;
    }
  };

  if (uninstall) {
    try {
      systemctl("disable", "--now", SYSTEMD_UNIT);
    } catch {
      // Already unloaded or not yet installed.
    }
    console.log(`unloaded  ${SYSTEMD_UNIT}; ${unitPath} left in place`);
    return;
  }

  const { bun, t3, path } = resolvePaths();
  const localCodexHome = join(homedir(), ".codex-factory-local");
  const codexHome = process.env.CODEX_HOME ?? (existsSync(localCodexHome) ? localCodexHome : undefined);
  const codexEnv = codexHome ? `Environment="CODEX_HOME=${codexHome}"\n` : "";
  const unit = `[Unit]
Description=Marshal Factory Runner
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
Environment="PATH=${path}"
Environment="HOME=${homedir()}"
Environment="T3CODE_CLI_PATH=${t3}"
${codexEnv}ExecStart=${bun} ${join(root, "runner/index.ts")}
Restart=always
RestartSec=10
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;

  mkdirSync(dirname(unitPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  const changed = !existsSync(unitPath) || readFileSync(unitPath, "utf8") !== unit;
  if (changed) writeFileSync(unitPath, unit);
  systemctl("daemon-reload");
  const wasActive = isActive();
  if (changed || !wasActive) {
    systemctl("enable", SYSTEMD_UNIT);
    systemctl("restart", SYSTEMD_UNIT);
  }
  console.log(`${changed ? "installed" : wasActive ? "unchanged" : "loaded"} ${SYSTEMD_UNIT}; log ${logPath}`);
}

function runDarwin(uninstall: boolean) {
  const plistPath = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
  const domain = `gui/${userInfo().uid}`;
  const launchctl = (...args: string[]) =>
    execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: "pipe" });
  const loaded = () => {
    try {
      launchctl("print", `${domain}/${LABEL}`);
      return true;
    } catch {
      return false;
    }
  };

  if (uninstall) {
    if (loaded()) launchctl("bootout", `${domain}/${LABEL}`);
    console.log(`unloaded  ${LABEL}; ${plistPath} left in place`);
    return;
  }

  const { bun, t3, path } = resolvePaths();
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${escape(bun)}</string><string>${escape(join(root, "runner/index.ts"))}</string></array>
  <key>WorkingDirectory</key><string>${escape(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escape(path)}</string>
    <key>HOME</key><string>${escape(homedir())}</string>
    <key>T3CODE_CLI_PATH</key><string>${escape(t3)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(logPath)}</string>
  <key>StandardErrorPath</key><string>${escape(logPath)}</string>
</dict>
</plist>
`;

  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  const changed = !existsSync(plistPath) || readFileSync(plistPath, "utf8") !== plist;
  if (changed) writeFileSync(plistPath, plist);
  if (changed && loaded()) {
    launchctl("bootout", `${domain}/${LABEL}`);
    for (let i = 0; i < 50 && loaded(); i++) execFileSync("/bin/sleep", ["0.2"]);
  }
  const wasLoaded = loaded();
  if (changed || !wasLoaded) launchctl("bootstrap", domain, plistPath);
  console.log(`${changed ? "installed" : wasLoaded ? "unchanged" : "loaded"} ${LABEL}; log ${logPath}`);
}

const uninstall = process.argv.includes("--uninstall");
if (process.platform === "linux") runLinux(uninstall);
else runDarwin(uninstall);
