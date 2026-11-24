import { expect, test } from "bun:test";
import { attributionLabels, labelCandidate, resolveAttribution, type LabelRow } from "./agentsview-labels";

const root = "6035301d-7a18-4b2b-be48-3d746659b648";
const row: LabelRow = {
  session_id: root,
  job_key: "FAC-61",
  branch: "factory/FAC-61",
  agent_id: null,
};

test("a Claude run and each of its children get the same job and attempt", () => {
  const candidates = [null, "a5f43d81383425dc5", "a2"].map((agent_id) => labelCandidate({ ...row, agent_id }));
  expect(candidates).toEqual([root, "agent-a5f43d81383425dc5", "agent-a2"].map((id) => ({
    id,
    session: root,
    attribution: { job: "FAC-61", attempt: 1 },
  })));
});

test("only branches for the same job with a positive safe attempt supply an attempt label", () => {
  const cases: [string | null, string[]][] = [
    ["factory/FAC-61-a002", ["mf.attempt=2"]],
    ["factory/FAC-61-a9007199254740991", ["mf.attempt=9007199254740991"]],
    [null, []],
    ["main", []],
    ["factory/FAC-99-a2", []],
    ["factory/FAC-61-a0", []],
    ["factory/FAC-61-a9007199254740992", []],
  ];
  for (const [branch, attemptLabels] of cases) {
    const candidate = labelCandidate({ ...row, branch });
    if (!candidate) throw new Error("Expected the Claude run to remain a candidate");
    expect(attributionLabels(candidate.attribution)).toEqual(["mf.job=FAC-61", ...attemptLabels]);
  }
});

test("synthetic runs, uppercase UUIDs, empty child IDs and Codex children are skipped", () => {
  for (const session_id of ["mcp:factory/FAC-61", "evidence:1", "inferred:1", root.toUpperCase()]) {
    expect(labelCandidate({ ...row, session_id, agent_id: "child" })).toBe(null);
  }
  for (const agent_id of ["", "codex:child"]) expect(labelCandidate({ ...row, agent_id })).toBe(null);
});

test("the saved job and verified attempt are stable across incomplete and conflicting observations", () => {
  const jobOnly = { job: "FAC-61", attempt: null };
  const verified = { job: "FAC-61", attempt: 2 };
  expect(resolveAttribution(null, jobOnly)).toEqual(jobOnly);
  expect(resolveAttribution(jobOnly, verified)).toEqual(verified);
  expect(resolveAttribution(verified, jobOnly)).toEqual(verified);
  expect(resolveAttribution(verified, { ...verified, attempt: 3 })).toBe(null);
  expect(resolveAttribution(jobOnly, { job: "FAC-62", attempt: null })).toBe(null);
});
