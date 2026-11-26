import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dir, encoding: "utf8" }).trim();

/** Outside the repo, so cleanup and `git clean` never touch it. */
export const VERIFY_HOME = process.env.VERIFY_HOME ?? join(homedir(), ".cache", "marshal-factory-verify");

/** One stack per checkout: two worktrees can each run their own on different VERIFY_PORTs. */
export const STATE_DIR = join(VERIFY_HOME, "stacks", createHash("sha1").update(REPO).digest("hex").slice(0, 12));
export const STATE_FILE = join(STATE_DIR, "state.json");

export type StackState = {
  project: string;
  branchId: string;
  branchName: string;
  endpointId: string;
  baseUrl: string;
  port: number;
  pid: number;
  /** Start time of `pid` (/proc/<pid>/stat field 22), so a reused pid is never taken for ours. */
  pidStart: string;
  ownerEmail: string;
  ownerPassword: string;
  env: Record<string, string>;
};

export const readState = (): StackState | null =>
  existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as StackState) : null;

/** Field 22 of /proc/<pid>/stat; null where there is no procfs. */
export const startTime = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
};

/** True only for the `next dev` this stack started, never for a process that reused its pid or a panel from another checkout. */
export const isOurs = (state: StackState) => state.pid > 0 && startTime(state.pid) === state.pidStart;

/** True when every listener on the stack's port is in the process group of its `next dev`, so the sign-in form came from our server. */
export const servesPort = (state: StackState): boolean => {
  if (!isOurs(state)) return false;
  let out: string;
  try {
    out = execFileSync("ss", ["-ltnpH", `sport = :${state.port}`], { encoding: "utf8" });
  } catch {
    return false;
  }
  // A listener owned by another user shows no pid, so each line must name one of ours.
  const lines = out.split("\n").filter(Boolean);
  return lines.length > 0 && lines.every((line) => {
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
    return pids.length > 0 && pids.every((pid) => processGroup(pid) === state.pid);
  });
};

const processGroup = (pid: number): number | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    return null;
  }
};

/** Serializes `up` and `down` in one checkout; a lock left by a dead holder is taken over. */
export async function withLock<T>(run: () => Promise<T> | T): Promise<T> {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const lock = join(STATE_DIR, "lock");
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(openSync(lock, "wx", 0o600), `${process.pid} ${startTime(process.pid)}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
      const [pid, start] = readFileSync(lock, "utf8").split(" ");
      if (startTime(Number(pid)) === start) throw new Error(`another stack.ts (pid ${pid}) is running in this checkout`);
      rmSync(lock, { force: true });
    }
  }
  try {
    return await run();
  } finally {
    rmSync(lock, { force: true });
  }
}
