import type { JobRow } from "../db/schema";
import { harnessLabel } from "./harness";
import { INBOX_ACTIONS, INBOX_KINDS, inboxItems, inboxReason, isDismissed, type InboxAction, type InboxJob, type InboxKind } from "./inbox";
import { mergeDecisionSchema, type MergeDecision } from "./merge-decision";
import { sourceLink } from "./sources/shapes";
import { isStopPending, parseStop, stopNeedsOwner } from "./stop";

// Slack notifications: which events send a message, what it says and what it says once resolved.
// Pure, so the runner's notifier (runner/slack.ts) and the regressions share the rules.
//
// An event is an inbox item (lib/inbox.ts), which stays open until it leaves the inbox, or an
// update the owner only hears about: a merge the factory did on its own, or a revert of one.
// Each event has a stable id, the key of its slack_messages row: one message per event, posted
// once and edited from then on, so the message a level 2 button sits on always finds its item.

export const NOTIFY_KINDS = ["question", "revert_failed", "stop_unconfirmed", "handover", "failed", "merged", "reverted"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export type SlackMessageState = "posting" | "open" | "resolved";

export const NOTIFY_TOGGLES = ["questions", "reviews", "failures", "reverts", "stops", "merges"] as const;
export type NotifyToggle = (typeof NOTIFY_TOGGLES)[number];

export const TOGGLE_LABELS: Record<NotifyToggle, string> = {
  questions: "Questions",
  reviews: "Reviews and handovers",
  failures: "Failures",
  reverts: "Reverts",
  stops: "Stops not confirmed",
  merges: "Merges by the factory",
};

export const TOGGLE_OF: Record<NotifyKind, NotifyToggle> = {
  question: "questions",
  handover: "reviews",
  failed: "failures",
  revert_failed: "reverts",
  reverted: "reverts",
  stop_unconfirmed: "stops",
  merged: "merges",
};

/** Sent during quiet hours too: main is red, or an agent may still be running and spending. */
export const URGENT: Record<NotifyKind, boolean> = {
  question: false,
  handover: false,
  failed: false,
  revert_failed: true,
  stop_unconfirmed: true,
  merged: false,
  reverted: false,
};

const EMOJI: Record<NotifyKind, string> = {
  question: "❓",
  handover: "👀",
  failed: "❌",
  revert_failed: "🚨",
  stop_unconfirmed: "⚠️",
  merged: "✅",
  reverted: "↩️",
};

const LABELS: Record<NotifyKind, string> = {
  question: "質問",
  revert_failed: "リバート失敗",
  handover: "レビュー待ち",
  failed: "失敗",
  stop_unconfirmed: "停止を確認できず",
  merged: "ファクトリーがマージ",
  reverted: "ファクトリーがリバート",
};

/** An event older than this when the notifier first sees it is not posted: it is in the panel, and Slack is for what is new. */
export const NOTIFY_WINDOW_MS = 24 * 3_600_000;

/**
 * The ids an open message's action buttons carry, one per inbox action; the interactivity route
 * (lib/slack-interactions.ts) dispatches on them, and a modal's callback id is the same id. The
 * link buttons' ids are there so that route can ack and ignore their clicks.
 */
export const SLACK_ACTION_IDS = {
  answer: "inbox:answer",
  approve: "inbox:approve",
  request_changes: "inbox:request_changes",
  follow_up: "inbox:follow_up",
  close: "inbox:close",
  dismiss: "inbox:dismiss",
  retry_stop: "inbox:retry_stop",
  retry: "inbox:retry",
} as const satisfies Record<InboxAction, string>;

export const slackAction = (actionId: string): InboxAction | null =>
  (Object.entries(SLACK_ACTION_IDS).find(([, id]) => id === actionId)?.[0] as InboxAction | undefined) ?? null;

/** The button each inbox action gets. */
export const ACTION_LABELS: Record<InboxAction, string> = {
  answer: "回答する",
  approve: "承認してマージする",
  request_changes: "修正を依頼する",
  follow_up: "フォローアップを起票する",
  close: "クローズする",
  dismiss: "見送る",
  retry_stop: "停止を再試行する",
  retry: "再試行する",
};

/** What the message says between the click and the notifier's resolution; it has no action buttons, so a second click finds none. */
export const PENDING_LABELS: Record<InboxAction, string> = {
  answer: "回答を送信しました",
  approve: "⏳ マージしています…",
  request_changes: "⏳ 修正依頼を送っています…",
  follow_up: "⏳ フォローアップを起票しています…",
  close: "⏳ クローズしています…",
  dismiss: "見送りました",
  retry_stop: "⏳ もう一度中断しています…",
  retry: "⏳ 再試行しています…",
};

const isInboxKind = (kind: NotifyKind): kind is InboxKind => (INBOX_KINDS as readonly string[]).includes(kind);
export const SLACK_LINK_ACTION_IDS = { panel: "link:panel", pr: "link:pr", source: "link:source" } as const;
/** The actions block's id is this plus the event id, so a click finds its slack_messages row. */
export const ITEM_BLOCK_PREFIX = "item:";
/** Level 3's job sources, as the app manifest in docs/operations.md declares them. */
export const SLACK_COMMAND = "/factory";
export const SLACK_SHORTCUT_CALLBACK_ID = "send_to_factory";

export type NotifyJob = InboxJob &
  Pick<JobRow, "id" | "source" | "title" | "url" | "repo" | "attempt" | "provider" | "question" | "stage_summary" | "answered_at">;

export type NotifyEvent<J extends NotifyJob = NotifyJob> = {
  id: string;
  kind: NotifyKind;
  job: J;
  at: Date;
  reason: string;
  /** An inbox item stays open until it leaves the inbox; an update is resolved as soon as it is posted. */
  open: boolean;
};

const parseDecision = (value: unknown): MergeDecision | null => mergeDecisionSchema.safeParse(value).data ?? null;

/** What tells one occurrence of a kind on a job from the next: a new question or failure is a new stage report. */
function occurrence(kind: InboxKind, job: NotifyJob) {
  if (kind === "stop_unconfirmed") return parseStop(job.stop)?.settledAt ?? "stop";
  return job.stage_at?.toISOString() ?? "stage";
}

export const eventId = (job: Pick<NotifyJob, "id" | "attempt">, kind: NotifyKind, occurs: string) => `${job.id}:${job.attempt}:${kind}:${occurs}`;

export function notifyEvents<J extends NotifyJob>(jobs: readonly J[]): NotifyEvent<J>[] {
  const events: NotifyEvent<J>[] = inboxItems(jobs).map((item) => ({
    id: eventId(item.job, item.kind, occurrence(item.kind, item.job)),
    kind: item.kind,
    job: item.job,
    at: item.at,
    reason: inboxReason(item),
    open: true,
  }));
  for (const job of jobs) {
    const decision = parseDecision(job.merge_decision);
    const merged = decision?.merged;
    if (!merged) continue;
    // A merge the owner approved resolves its handover message instead.
    if ((merged.via ?? "auto") === "auto") {
      events.push({
        id: eventId(job, "merged", merged.sha),
        kind: "merged",
        job,
        at: new Date(merged.at),
        reason: `${merged.base} に ${merged.sha.slice(0, 7)} としてマージしました。`,
        open: false,
      });
    }
    const watch = decision.watch;
    if (watch?.state === "reverted") {
      events.push({
        id: eventId(job, "reverted", merged.sha),
        kind: "reverted",
        job,
        at: new Date(merged.at),
        reason: `マージ後に ${merged.base} が赤くなった${watch.failed.length > 0 ? `（${watch.failed.join(", ")}）` : ""}ため、ファクトリーがリバートしました。`,
        open: false,
      });
    }
  }
  return events;
}

/** What a resolved message says happened, from the job as it is now; undefined when the job is gone. */
export function resolution(kind: NotifyKind, job: NotifyJob | undefined): string {
  if (!job) return "解決済み";
  const decision = parseDecision(job.merge_decision);
  const closed = job.stage === "failed" && isDismissed(job);
  switch (kind) {
    case "question":
      if (job.stage === "failed") return closed ? "クローズ済み" : "❌ 失敗";
      return job.answered_at && job.stage_at && job.answered_at >= job.stage_at ? "✅ 回答済み" : "次の段階に進みました";
    case "handover":
      if (decision?.merged) return "✅ ファクトリーがマージ";
      if (job.stage === "merged") return "✅ マージ済み";
      if (decision?.merging) return "✅ 承認済み、マージ中";
      if (job.stage === "failed") return closed ? "クローズ済み" : "❌ 失敗";
      if (job.stage === "pr") return "ファクトリーに戻りました";
      return "↩️ 修正を依頼済み";
    case "failed":
      if (job.stage !== "failed") return "🔁 再試行済み";
      return isDismissed(job) ? "見送り済み" : "次の段階に進みました";
    case "revert_failed":
      return isDismissed(job) ? "見送り済み" : "解決済み";
    case "stop_unconfirmed": {
      if (stopNeedsOwner(job.stop, job.dismissed_at)) return "解決済み";
      const stop = parseStop(job.stop);
      if (stop?.state === "confirmed") return "✅ 停止を確認";
      // A retry that ends unconfirmed again is a new event, with its own message.
      if (isStopPending(stop)) return "🔁 停止を再試行中";
      return job.dismissed_at ? "見送り済み" : "解決済み";
    }
    case "merged":
    case "reverted":
      return LABELS[kind];
    default: {
      const never: never = kind;
      throw new Error(`unknown notify kind ${String(never)}`);
    }
  }
}

// What could pass for a credential in an agent's summary or question; it never reaches Slack.
const SECRET_PATTERNS = [
  /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /xapp-[A-Za-z0-9-]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /lin_(?:api|oauth)_[A-Za-z0-9]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** Replaces token-shaped strings and the given secret values with a marker. */
export function redact(text: string, secrets: readonly string[] = []) {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** Slack mrkdwn treats these three as control characters. */
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const HEADER_MAX = 150;
const REASON_MAX = 300;
const TEXT_MAX = 300;

type PlainText = { type: "plain_text"; text: string; emoji?: boolean };
type Mrkdwn = { type: "mrkdwn"; text: string };
type LinkButton = { type: "button"; text: PlainText; url: string; action_id: string };
type Confirm = { title: PlainText; text: Mrkdwn; confirm: PlainText; deny: PlainText };
type ActionButton = { type: "button"; text: PlainText; action_id: string; style?: "primary"; confirm?: Confirm };
export type SlackBlock =
  | { type: "header"; text: PlainText }
  | { type: "section"; text: Mrkdwn }
  | { type: "context"; elements: Mrkdwn[] }
  | { type: "actions"; block_id: string; elements: (ActionButton | LinkButton)[] };
export type SlackMessage = { text: string; blocks: SlackBlock[] };

export type MessageFacts = {
  panelUrl: string;
  /** The attempt's spend; null when nothing was recorded. */
  spend: { usd: number; known: boolean } | null;
  /** Values that must never show, such as the runner's tokens. */
  secrets: readonly string[];
};

const usd = (spend: NonNullable<MessageFacts["spend"]>) => `$${spend.usd.toFixed(2)}${spend.known ? "" : "+"}`;

export const panelUrl = () => (process.env.FACTORY_PANEL_URL ?? "https://marshal-factory.vercel.app").replace(/\/+$/, "");

/** Environment variables whose values must never reach Slack, whatever an agent writes. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL)/i;
export const secretValues = (env: Record<string, string | undefined>) => Object.entries(env).flatMap(([name, value]) => (value && SECRET_NAME.test(name) ? [value] : []));

function actionButton(action: InboxAction, job: NotifyJob): ActionButton {
  const button: ActionButton = { type: "button", text: { type: "plain_text", text: ACTION_LABELS[action] }, action_id: SLACK_ACTION_IDS[action] };
  if (action !== "approve") return button;
  return {
    ...button,
    style: "primary",
    confirm: {
      title: { type: "plain_text", text: "承認してマージしますか？" },
      text: {
        type: "mrkdwn",
        text: clip(`ファクトリーが自動マージと同じ手順で ${escape(job.key)} を ${escape(job.repo)} にマージし、その後マージ先のブランチを見守ります。新しい push、失敗中または実行中のチェック、コンフリクト、GitHub によるマージ拒否のいずれかがあれば、マージは止まります。`, TEXT_MAX),
      },
      confirm: { type: "plain_text", text: "承認してマージする" },
      deny: { type: "plain_text", text: "キャンセル" },
    },
  };
}

/**
 * The message for an event: open with the actions its inbox kind offers, pending (an action is on
 * its way, no action buttons) or with what resolved it.
 */
export function renderMessage(
  event: Pick<NotifyEvent, "id" | "kind" | "job" | "reason">,
  facts: MessageFacts,
  resolved: string | null = null,
  pending: string | null = null,
): SlackMessage {
  const { job, kind } = event;
  const clean = (text: string) => redact(text, facts.secrets).replace(/\s+/g, " ").trim();
  const title = clean(job.title);
  const reason = clip(clean(event.reason), REASON_MAX);
  const status = resolved ?? pending;
  const line = status ? `*${escape(status)}* · ${LABELS[kind]}` : `*${LABELS[kind]}:* ${escape(reason)}`;
  const actions: readonly InboxAction[] = !status && isInboxKind(kind) ? INBOX_ACTIONS[kind] : [];
  const meta = [job.repo, ...(job.provider ? [harnessLabel(job.provider)] : []), ...(facts.spend ? [usd(facts.spend)] : [])];
  const source = sourceLink(job);
  const links: LinkButton[] = [
    { type: "button", text: { type: "plain_text", text: "パネルで開く" }, url: `${facts.panelUrl}/inbox?job=${encodeURIComponent(job.key)}`, action_id: SLACK_LINK_ACTION_IDS.panel },
    ...(job.pr_url ? [{ type: "button" as const, text: { type: "plain_text" as const, text: "プルリクエスト" }, url: job.pr_url, action_id: SLACK_LINK_ACTION_IDS.pr }] : []),
    ...(/^https?:\/\//.test(source.href)
      ? [{ type: "button" as const, text: { type: "plain_text" as const, text: `${source.label} のイシュー` }, url: source.href, action_id: SLACK_LINK_ACTION_IDS.source }]
      : []),
  ];
  return {
    text: clip(`${EMOJI[kind]} ${job.key} · ${title}: ${status ?? reason}`, TEXT_MAX),
    blocks: [
      { type: "header", text: { type: "plain_text", text: clip(`${EMOJI[kind]} ${job.key} · ${title}`, HEADER_MAX), emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: line } },
      { type: "context", elements: [{ type: "mrkdwn", text: escape(meta.join(" · ")) }] },
      { type: "actions", block_id: `${ITEM_BLOCK_PREFIX}${event.id}`.slice(0, 255), elements: [...actions.map((a) => actionButton(a, job)), ...links] },
    ],
  };
}

/** The message Settings' "Send test message" posts. */
export function renderTest(actor: string): SlackMessage {
  const text = `👋 Marshal Factory からのテストメッセージです（送信者: ${actor}）。通知はこの会話に届きます。`;
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text: escape(text) } }] };
}
