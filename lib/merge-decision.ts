import { z } from "zod";
import type { MergeAssessment } from "./assessment";
import { headEvidenceSchema, notVerifiedWhy, shortSha, type HeadEvidence } from "./evidence";
import { uiFiles } from "./screenshots";

// Whether a factory PR would merge on its own. The agent recommends merge unless it isn't confident
// (lib/assessment.ts); the runner enforces factual hard limits that no recommendation overrides. Pure, so the runner pass and the
// regressions share it.

export const AUTONOMY_LEVELS = ["off", "trial", "auto"] as const;
export const autonomySchema = z.enum(AUTONOMY_LEVELS);
export type Autonomy = z.infer<typeof autonomySchema>;

export const AUTONOMY_LABELS: Record<Autonomy, string> = { off: "Off", trial: "Trial", auto: "Merge when confident" };

export const CHECKS_TIMEOUT_MS = 60 * 60_000;
/** How long a head with no check run and no status may wait for CI to start before it counts as having none. */
export const DEFAULT_NO_CI_GRACE_MS = 5 * 60_000;
export const REVIEW_LABEL = "review";

/** `requireBugbot` false means the repo has no Bugbot: its review is neither awaited nor read. */
export type RepoPolicy = { autonomy: Autonomy; requireBugbot: boolean };
export const DEFAULT_POLICY: RepoPolicy = { autonomy: "off", requireBugbot: true };

export const MERGE_OUTCOMES = ["merge", "handover", "pending"] as const;
export type MergeOutcome = (typeof MERGE_OUTCOMES)[number];

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** Where a factory merge started: the timer's own decision, or the owner's approval in the inbox or in run detail. */
export const MERGE_VIAS = ["auto", "inbox", "run_detail"] as const;
export type MergeVia = (typeof MERGE_VIAS)[number];

export const WATCH_STATES = ["watching", "green", "expired", "reverted", "revert_failed"] as const;
export type WatchState = (typeof WATCH_STATES)[number];

/** What the factory merged; the post-merge watch reads the base branch at this commit. */
export const factoryMergeSchema = z.object({
  sha: z.string(),
  method: z.enum(MERGE_METHODS),
  at: z.string(),
  base: z.string(),
  title: z.string(),
  /** The PR's commit count; a rebase merge put that many commits on the base. */
  commits: z.number().int().positive(),
  /** Absent on merges recorded before the entry point was kept. */
  via: z.enum(MERGE_VIAS).optional(),
});
export type FactoryMerge = z.infer<typeof factoryMergeSchema>;

export const watchSchema = z.object({
  state: z.enum(WATCH_STATES),
  until: z.string(),
  /** The checks that failed on the base branch. */
  failed: z.array(z.string()),
  revertPr: z.string().nullable(),
  /** Why the revert failed. */
  reason: z.string().nullable(),
});
export type MergeWatch = z.infer<typeof watchSchema>;

/** The most changed files a review summary lists; fileCount still counts them all. */
export const REVIEW_FILE_LIMIT = 100;

/** What the owner reviews in the inbox: the PR's changed files and Bugbot's findings at one head. */
export const reviewSchema = z.object({
  headSha: z.string(),
  files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number() })),
  fileCount: z.number().int(),
  bugbot: z.object({
    state: z.enum(["pending", "reviewed", "failed"]),
    /** Unresolved findings by severity. */
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
    resolved: z.number().int(),
  }),
});
export type ReviewSummary = z.infer<typeof reviewSchema>;

export const verificationSchema = z.object({
  sha: z.string(),
  at: z.string(),
  state: z.enum(["running", "failed"]),
  reason: z.string().optional(),
});
export type RunnerVerificationRecord = z.infer<typeof verificationSchema>;

/**
 * Whether the runner can settle an unproven head by running the checks itself: it may start, it is
 * running them, it tried and couldn't, or it can't for this job at all.
 */
export type RunnerVerification = { kind: "available" } | { kind: "running" } | { kind: "failed"; reason: string } | { kind: "unavailable"; reason: string };

export const mergeDecisionSchema = z.object({
  outcome: z.enum(MERGE_OUTCOMES),
  reasons: z.array(z.string()),
  autonomy: autonomySchema,
  evaluatedAt: z.string(),
  /** The PR head the decision is about; null when autonomy is off and GitHub was not asked. */
  headSha: z.string().nullable(),
  /** When this head was first seen, so the checks timeout runs from the push, not the latest pass. */
  headSeenAt: z.string().nullable(),
  /** The stage event the decision read the assessment from. */
  stageEventId: z.string().nullable(),
  /** Why GitHub refused the factory's merge of this head; it is not tried again until the head moves. */
  blocked: z.string().optional(),
  /** Written right before the factory asks GitHub to merge, so a crash after the merge is recorded on a later pass. */
  merging: z.object({ headSha: z.string(), method: z.enum(MERGE_METHODS), at: z.string(), via: z.enum(MERGE_VIAS).optional() }).optional(),
  merged: factoryMergeSchema.optional(),
  watch: watchSchema.optional(),
  /** Fingerprints of the decision comments last posted on the PR and in the source. */
  comments: z.object({ pr: z.string().optional(), source: z.string().optional() }).optional(),
  /** The facts the decision read, for the inbox; absent when autonomy is off, which reads none. */
  review: reviewSchema.optional(),
  /** Set when the owner approved this head in the inbox or run detail; the merge then skips the agent's and the policy's reasons. */
  approvedBy: z.string().optional(),
  /** What the evidence proved about headSha when the decision read it; absent when autonomy is off or before evidence existed. */
  evidence: headEvidenceSchema.optional(),
  /** The runner's own run of the checks at headSha in the job's sandbox; at most one per head. */
  verification: verificationSchema.optional(),
});
export type MergeDecision = z.infer<typeof mergeDecisionSchema>;

/** `none`: no check run or status reported on the head past the grace period, and the base branch requires none. */
export type CheckState = "success" | "pending" | "failure" | "none";
export type BugbotFinding = { severity: "high" | "medium" | "low"; resolved: boolean };
/** Bugbot's run on the head: still running (or not started), reviewed, or ended without a review. */
export type BugbotReview = { state: "pending" } | { state: "reviewed" } | { state: "failed"; conclusion: string };
export type ChangedFile = { path: string; additions: number; deletions: number };

/** What GitHub says about the PR head. */
export type PrFacts = {
  headSha: string;
  mergeable: "mergeable" | "conflicting" | "unknown";
  /** Every check run and commit status on the head, Bugbot's aside; pending also when none reported yet, none once the repo has no CI. */
  checks: CheckState;
  bugbot: { review: BugbotReview; findings: readonly BugbotFinding[] };
  files: readonly ChangedFile[];
};

export type DecisionInput = {
  policy: RepoPolicy;
  assessment: MergeAssessment | null;
  labels: readonly string[];
  /** Null only when autonomy is off, which never asks GitHub. */
  pr: PrFacts | null;
  headSeenAt: number;
  now: number;
  checksTimeoutMs?: number;
  /** What the evidence for this attempt proves about the PR head; see lib/evidence.ts. */
  evidence: HeadEvidence;
  runner: RunnerVerification;
  /** Why the PR edits what its checks depend on (lib/trusted-checks.ts). Any makes it a handover whatever the evidence says. */
  trustEdits: readonly string[];
  /** Whether the agent had the sandbox's headless browser, so a change to a page can come with screenshots. */
  browser: boolean;
};

/** `verify` is set when only verification at the head stands between the PR and a merge, and the runner may run it. */
export type Decision = { outcome: MergeOutcome; reasons: string[]; verify?: true };

const minutes = (ms: number) => Math.round(ms / 60_000);

/** Hard limits only; each failure is one plain reason. */
function hardLimits(input: DecisionInput, pr: PrFacts) {
  const reasons: string[] = [];
  if (input.labels.some((l) => l.toLowerCase() === REVIEW_LABEL)) reasons.push(`イシューに "${REVIEW_LABEL}" ラベルが付いています。`);
  if (pr.checks === "failure") reasons.push("最新のコミットでチェックが失敗しました。");
  if (pr.mergeable === "conflicting") reasons.push("プルリクエストがベースブランチとコンフリクトしています。");
  if (input.policy.requireBugbot) {
    if (pr.bugbot.review.state === "failed") reasons.push(`Bugbot がレビューを完了しませんでした（${pr.bugbot.review.conclusion}）。`);
    const open = pr.bugbot.findings.filter((f) => !f.resolved && f.severity !== "low");
    if (open.length > 0) reasons.push(`Bugbot の未解決の medium または high の指摘が ${open.length} 件あります。`);
  }
  return reasons;
}

function agentReasons({ assessment }: DecisionInput) {
  if (!assessment) return ["エージェントが評価を報告しませんでした。"];
  if (assessment.recommendation === "merge") return [];
  return [`エージェントに確信がありません: ${assessment.confidence.reason ?? "引き継ぎを勧めています。"}`];
}

/** A change to a page needs screenshots of it, when the agent had a browser to take them with. */
function screenshotReasons({ assessment, browser }: DecisionInput, pr: PrFacts): string[] {
  if (!browser || !assessment || assessment.screenshots?.length) return [];
  const ui = uiFiles(pr.files.map((f) => f.path));
  if (ui.length === 0) return [];
  const named = ui.slice(0, 3).join(", ") + (ui.length > 3 ? `、ほか ${ui.length - 3} 件` : "");
  return [`プルリクエストが UI ファイル（${named}）を変更していますが、エージェントはスクリーンショットを添付していません。`];
}

/** The verified-at-head limit: what the agent or the runner ran at exactly the PR's head. */
function evidenceReasons({ evidence, runner }: DecisionInput, pr: PrFacts): string[] {
  const head = shortSha(pr.headSha);
  switch (evidence.state) {
    case "verified":
      return [];
    case "no_checks":
      return ["このリポジトリにはチェックが定義されていません。"];
    case "failed":
      return [`${head} でチェックが失敗しました: ${evidence.failed.join(", ")}。`];
    case "missing":
    case "stale":
    case "dirty":
    case "incomplete":
    case "untrusted":
      switch (runner.kind) {
        case "available":
        case "running":
          return [];
        case "failed":
          return [`${head} では未検証です（${notVerifiedWhy(evidence)}）。ファクトリー自身もチェックを実行できませんでした: ${runner.reason}。`];
        case "unavailable":
          return [`${head} では未検証です（${notVerifiedWhy(evidence)}）。${runner.reason}。`];
        default: {
          const never: never = runner;
          throw new Error(`unknown runner verification ${String(never)}`);
        }
      }
    default: {
      const never: never = evidence;
      throw new Error(`unknown evidence state ${String(never)}`);
    }
  }
}

const verificationWait = (pr: PrFacts) => `${shortSha(pr.headSha)} での検証`;

function waitingOn(input: DecisionInput, pr: PrFacts) {
  const waiting: string[] = [];
  if (pr.checks === "pending") waiting.push("チェック");
  if (input.policy.requireBugbot && pr.bugbot.review.state === "pending") waiting.push("Bugbot");
  if (pr.mergeable === "unknown") waiting.push("GitHub のマージ可否の確認");
  if (evidenceReasons(input, pr).length === 0 && input.evidence.state !== "verified") waiting.push(verificationWait(pr));
  return waiting;
}

/** Off evaluates nothing: the PR is ready for review, with no reasons to give. */
export const OFF_DECISION: Decision = { outcome: "handover", reasons: [] };

export function decideMerge(input: DecisionInput): Decision {
  if (input.policy.autonomy === "off") return OFF_DECISION;
  if (!input.pr) throw new Error("decideMerge needs the PR's facts unless autonomy is off");
  const reasons = [...agentReasons(input), ...hardLimits(input, input.pr), ...screenshotReasons(input, input.pr), ...input.trustEdits, ...evidenceReasons(input, input.pr)];
  if (reasons.length > 0) return { outcome: "handover", reasons };
  const waiting = waitingOn(input, input.pr);
  if (waiting.length > 0) {
    const timeout = input.checksTimeoutMs ?? CHECKS_TIMEOUT_MS;
    if (input.now - input.headSeenAt < timeout) {
      const onlyVerification = waiting.length === 1 && waiting[0] === verificationWait(input.pr) && input.runner.kind === "available";
      return { outcome: "pending", reasons: [`待機中: ${waiting.join("、")}`], ...(onlyVerification && { verify: true as const }) };
    }
    return { outcome: "handover", reasons: [`${minutes(timeout)} 分以内に終わりませんでした: ${waiting.join("、")}`] };
  }
  return { outcome: "merge", reasons: input.pr.checks === "none" ? [noCiReason(input.pr.headSha)] : [] };
}

/** Said on a merge where the factory's evidence at the head stood in for CI. */
export const noCiReason = (headSha: string) => `このリポジトリには CI がないため、${shortSha(headSha)} でのファクトリー自身のチェックを根拠にしています。`;

export function reviewSummary(pr: Pick<PrFacts, "headSha" | "files" | "bugbot">): ReviewSummary {
  const open = pr.bugbot.findings.filter((f) => !f.resolved);
  const count = (severity: BugbotFinding["severity"]) => open.filter((f) => f.severity === severity).length;
  return {
    headSha: pr.headSha,
    files: pr.files.slice(0, REVIEW_FILE_LIMIT).map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    fileCount: pr.files.length,
    bugbot: { state: pr.bugbot.review.state, high: count("high"), medium: count("medium"), low: count("low"), resolved: pr.bugbot.findings.length - open.length },
  };
}

/**
 * What still stops a merge the owner approved. Only facts about the PR count: the agent's
 * reasons, the policy's limits and Bugbot's findings are the owner's to overrule.
 */
export function approvalBlockers(pr: Pick<PrFacts, "checks" | "mergeable">): string[] {
  const reasons: string[] = [];
  if (pr.checks === "failure") reasons.push("最新のコミットでチェックが失敗しました。");
  if (pr.checks === "pending") reasons.push("最新のコミットでチェックがまだ実行中です。");
  if (pr.mergeable === "conflicting") reasons.push("プルリクエストがベースブランチとコンフリクトしています。");
  if (pr.mergeable === "unknown") reasons.push("GitHub がプルリクエストを問題なくマージできるか確認しています。");
  return reasons;
}

/** The reason a decision hands over when GitHub refuses the factory's merge. */
export const blockedReason = (detail: string) => `ファクトリーの GitHub App はこのリポジトリでマージできません: ${detail}`;
