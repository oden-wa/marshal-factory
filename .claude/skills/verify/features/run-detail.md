# Run detail pane

The right-hand pane that opens when the owner selects a job's run. It shows the job header, the latest stage summary or question, the merge decision with the agent's interpretation and assumptions, evidence, the stage timeline, agents and live events.

## Sub-features

- `detail-header` shows the job key, title, status badges, machine, cost and the `Pull request` link.
- `detail-answer` shows the owner's last answer (`Answer received <time>`) or the open question.
- `detail-merge-decision` shows `Merge decision`, the agent's recommendation, `Interpretation` and `Assumptions`.
- `detail-timeline` lists stage events under `Timeline`.
- `detail-activity` lists `Agents · <n>` and `Live events`.

## How to get to it (user POV)

- Open `Jobs`, switch to `List`, and click a job row.
- Open `/?view=list&run=<session_id>` directly. The `expand` button opens the same pane full width.

## Driving it with drive.ts

Preconditions: the job has a run on the branch. `FAC-2` has session id `mcp:factory/FAC-2` (URL-encoded `mcp%3Afactory%2FFAC-2`).

- **Open the pane.** Run `bun .claude/skills/verify/scripts/drive.ts shot "/?view=list&run=mcp%3Afactory%2FFAC-2" run-detail-fac2`. The `.txt` holds `FAC-2 · factory/FAC-2`, the title, and `Merge decision`.
- **Open from the list.** In a journey, `await page.goto(base + "/?view=list")`, then `await page.getByText("FAC-2", { exact: true }).click()`. The URL gains `run=` and the pane renders the same header.
- **Proof.** Grep the `.txt` for each heading the change touched (`Merge decision`, `Interpretation`, `Assumptions`, `Timeline`, `Live events`) and the PNG for layout.

## Gotchas

- `networkidle` fires before the pane leaves its skeleton. `shot` waits for `aria-busy` and `data-slot="skeleton"` to detach; a hand-rolled screenshot must do the same.
- Text the agent wrote (stage summary, interpretation, assumptions) is data from the branch copy, not code. A change to how agents write it shows only on rows written after the change, so seed a row on the branch to prove it.
- Realtime is off in this stack. Reload to see a row written after the page loaded.
