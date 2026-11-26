import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
