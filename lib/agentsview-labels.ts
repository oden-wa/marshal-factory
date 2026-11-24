import { parseBranch } from "./factory";

export const CLAUDE_SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export type LabelRow = {
  session_id: string;
  job_key: string;
  branch: string | null;
  agent_id: string | null;
};

export type Attribution = { job: string; attempt: number | null };

export function labelCandidate(row: LabelRow) {
  if (!CLAUDE_SESSION_ID.test(row.session_id)) return null;
  if (row.agent_id === "" || row.agent_id?.startsWith("codex:")) return null;
  const branch = parseBranch(row.branch ?? undefined);
  const attempt = branch?.key === row.job_key && Number.isSafeInteger(branch.attempt) && branch.attempt > 0
    ? branch.attempt
    : null;
  return {
    id: row.agent_id === null ? row.session_id : `agent-${row.agent_id}`,
    session: row.session_id,
    attribution: { job: row.job_key, attempt },
  };
}

export function resolveAttribution(saved: Attribution | null, observed: Attribution): Attribution | null {
  if (!saved) return observed;
  if (saved.job !== observed.job) return null;
  if (observed.attempt === null || observed.attempt === saved.attempt) return saved;
  if (saved.attempt === null) return observed;
  return null;
}

export function attributionLabels({ job, attempt }: Attribution): string[] {
  const labels = [`mf.job=${job}`];
  if (attempt !== null) labels.push(`mf.attempt=${attempt}`);
  return labels;
}
