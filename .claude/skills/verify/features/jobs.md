# Jobs board and list

The home page. A metrics strip (`Active runs`, `Idle runs`, `Running agents`, `Tokens today`, `Spend today`) above jobs grouped by stage, as a board or a list.

## Sub-features

- `jobs-board` shows stage columns (`/`).
- `jobs-list` shows groups such as `PR · CI`, `Waiting on you`, `Merged` (`/?view=list`).
- `jobs-filter` narrows by repository with the `All repositories` picker.

## How to get to it (user POV)

- Click `Jobs` in the sidebar; toggle `Board` and `List` in the header.

## Driving it with drive.ts

- **Board.** `drive.ts shot / jobs-board`. The `.txt` holds the five metric labels and every job key on the branch.
- **List.** `drive.ts shot "/?view=list" jobs-list`. The `.txt` holds the group names with their counts and the footer `<n> jobs`.
- **Toggle.** In a journey, `await page.getByRole("button", { name: "List" }).click()`; the URL gains `view=list`.

## Gotchas

- Metric values come from the branch copy and drift from production after `up`. Assert labels and structure, not numbers.
- The footer reads `Live updates off in previews` because the stack sets `VERCEL_ENV=preview`. That is expected here, not a regression.
