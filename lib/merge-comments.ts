import { createHash } from "node:crypto";
import type { MergeAssessment } from "./assessment";
import { shortSha } from "./evidence";
import type { MergeDecision } from "./merge-decision";

// The comments a merge decision leaves on its PR and in its source. Each body follows from the
// decision alone, so the runner posts one only when its fingerprint changes.

export const DECISION_MARKER = "<!-- marshal-factory:decision -->";

export const fingerprint = (body: string) => createHash("sha256").update(body).digest("hex").slice(0, 16);

const bullets = (items: readonly string[]) => items.map((i) => `- ${i}`).join("\n");
const failedList = (failed: readonly string[]) => (failed.length > 0 ? failed.join(", ") : "チェックの失敗");

const confidenceLine = ({ confidence }: MergeAssessment) =>
  confidence.confident ? "イシューが求めるものを作れていて、動作することに確信があります。" : `確信がありません: ${confidence.reason ?? "理由の記載なし。"}`;

function assessmentBlock(assessment: MergeAssessment | null) {
  if (!assessment) return [];
  return [
    `**イシューの解釈**\n\n${assessment.interpretation}`,
    assessment.assumptions.length > 0 ? `**前提にしたこと**\n\n${bullets(assessment.assumptions)}` : "",
    `**確信度**\n\n${confidenceLine(assessment)}`,
    assessment.notes ? `**補足**\n\n${assessment.notes}` : "",
  ];
}

function watchLine({ watch }: MergeDecision) {
  if (!watch) return "";
  switch (watch.state) {
    case "reverted":
      return `main が赤くなった（${failedList(watch.failed)}）ため、${watch.revertPr} でリバートしました。`;
    case "revert_failed":
      return `マージ後に main が赤くなり（${failedList(watch.failed)}）、リバートにも失敗しました: ${watch.reason}`;
    case "watching":
    case "green":
    case "expired":
      return "";
    default: {
      const never: never = watch.state;
      throw new Error(`unknown watch state ${String(never)}`);
    }
  }
}

/** What the merge rests on beyond GitHub's checks: the checks run at exactly the merged head. */
function evidenceLine({ evidence }: MergeDecision) {
  if (evidence?.state !== "verified") return "";
  return `${shortSha(evidence.sha)} で検証済み · ${evidence.passed}/${evidence.total} 件のチェックを${evidence.producer === "agent" ? "エージェント" : "ファクトリー"}が実行しました。`;
}

/** The PR comment for the decision, or null when it has nothing to say there yet. */
export function prCommentBody(decision: MergeDecision, assessment: MergeAssessment | null): string | null {
  const parts = (() => {
    if (decision.merged) return ["✅ ファクトリーがマージしました", evidenceLine(decision), watchLine(decision), ...assessmentBlock(assessment)];
    if (decision.autonomy === "off") return null;
    switch (decision.outcome) {
      case "pending":
        return null;
      case "merge":
        return decision.autonomy === "trial" ? ["マージ可と判断（試行）", evidenceLine(decision), ...assessmentBlock(assessment)] : null;
      case "handover":
        if (decision.autonomy === "trial") return [`引き継ぎと判断（試行）。理由:\n\n${bullets(decision.reasons)}`];
        return [
          "レビューをお願いします",
          bullets(decision.reasons),
          assessment?.notes ? `**補足**\n\n${assessment.notes}` : "",
        ];
      default: {
        const never: never = decision.outcome;
        throw new Error(`unknown merge outcome ${String(never)}`);
      }
    }
  })();
  return parts && [DECISION_MARKER, ...parts].filter(Boolean).join("\n\n");
}

/** The source comment for the decision: merges, handovers and reverts, never a pending tick. */
export function sourceCommentBody(decision: MergeDecision, prUrl: string): string | null {
  if (decision.merged) {
    const watch = decision.watch;
    if (watch?.state === "reverted") return `リバートしました: マージ後に main が赤くなりました — ${failedList(watch.failed)}。リバート: ${watch.revertPr}`;
    if (watch?.state === "revert_failed") {
      return `ファクトリーが ${prUrl} をマージした後に main が赤くなりました — ${failedList(watch.failed)}。リバートに失敗したため、手動でリバートしてください: ${watch.reason}`;
    }
    return `ファクトリーがマージしました: ${prUrl}`;
  }
  if (decision.autonomy === "off") return null;
  switch (decision.outcome) {
    case "pending":
      return null;
    case "merge":
      return decision.autonomy === "trial" ? `マージ可と判断（試行）: ${prUrl}` : null;
    case "handover":
      return `${decision.autonomy === "trial" ? "引き継ぎと判断（試行）" : "レビューをお願いします"}: ${prUrl}\n\n${bullets(decision.reasons)}`;
    default: {
      const never: never = decision.outcome;
      throw new Error(`unknown merge outcome ${String(never)}`);
    }
  }
}
