import type { FactoryLimits } from "./config";
import type { Stage } from "./events";
import { OWNER_LANGUAGE } from "./owner-language";

export type ThreadState = "running" | "stopped" | "gone";

export type WatchInput = {
  stage: Stage;
  lastEventAt: Date;
  nudgedAt: Date | null;
  nudgedStage: Stage | null;
  thread: ThreadState;
  /** False for a harness that reports no stages, so quiet says nothing about whether it is stuck. */
  tracked: boolean;
  now: Date;
};

export type WatchAction =
  | { kind: "ok" }
  | { kind: "reset" }
  | { kind: "nudge"; idleMinutes: number }
  | { kind: "fail"; reason: string };

const minutes = (ms: number) => ms / 60_000;

/**
 * Decides what a working job needs. A run is stuck when it has been quiet past the threshold,
 * or its thread stopped and stayed quiet past a short grace. The first time it gets a nudge; if
 * it is still stuck in the same stage after the second threshold, it fails. An untracked run is
 * only failed when its thread is gone.
 */
export function watch(input: WatchInput, limits: FactoryLimits): WatchAction {
  const idle = minutes(input.now.getTime() - input.lastEventAt.getTime());
  const nudged = input.nudgedAt !== null && input.nudgedStage === input.stage;

  if (input.thread === "gone") {
    return { kind: "fail", reason: `T3 スレッドがなくなりました（ステージ ${input.stage}）` };
  }
  if (!input.tracked) return input.nudgedAt ? { kind: "reset" } : { kind: "ok" };
  const stuck =
    idle >= limits.stuckAfterMinutes ||
    (input.thread === "stopped" && idle >= limits.stoppedGraceMinutes);
  if (!stuck) return input.nudgedAt && !nudged ? { kind: "reset" } : { kind: "ok" };
  if (!nudged) return { kind: "nudge", idleMinutes: Math.round(idle) };

  const sinceNudge = minutes(
    input.now.getTime() - Math.max(input.nudgedAt!.getTime(), input.lastEventAt.getTime()),
  );
  if (sinceNudge < limits.failAfterNudgeMinutes) return { kind: "ok" };
  return {
    kind: "fail",
    reason: `ウォッチドッグが促したあとも、ステージ ${input.stage} で ${Math.round(sinceNudge)} 分進みがありません（スレッド ${input.thread}）`,
  };
}

export function nudgeMessage(key: string, stage: Stage, idleMinutes: number, playbook: string) {
  return [
    `Watchdog: factory run ${key} has made no progress for ${idleMinutes} minutes in stage ${stage}.`,
    "",
    `Continue the factory playbook (${playbook}) where you left off. Call report_stage with your current stage now. If you are blocked, report waiting with a concrete question. If you cannot continue, report failed with the reason.`,
    "",
    OWNER_LANGUAGE,
  ].join("\n");
}
