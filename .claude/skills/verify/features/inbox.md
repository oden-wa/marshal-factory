# Inbox

The list of jobs waiting on the owner (questions, reviews, merge decisions) with a detail pane per item.

## Sub-features

- `inbox-list` lists items in `<ul aria-label="Needs you">`; the sidebar `Inbox` badge counts them.
- `inbox-detail` shows the item under `Why it's here`, `Evidence`, `Confidence`, `Screenshots`, `Notes`, `Assumptions`, `Changes`, `Bugbot`.

## How to get to it (user POV)

- Click `Inbox` in the sidebar, or the `<n> need you` button in the Jobs header.
- Open `/inbox?job=<key>` directly.

## Driving it with drive.ts

Preconditions: at least one job on the branch is waiting on the owner (the sidebar badge is non-zero).

- **List.** `drive.ts shot /inbox inbox`. The ARIA snapshot holds `list "Needs you"` with one item per waiting job.
- **Open an item.** In a journey, `await page.getByRole("list", { name: "Needs you" }).getByRole("link").first().click()`, then `shot("item", page.getByText("Why it's here"))`. The pane's `h2` is the job title and `Why it's here` is present.
- **Close.** `await page.getByRole("link", { name: "Close" }).click()` returns to `/inbox`.

## Gotchas

- Sections render only when their data exists, so a missing `Screenshots` heading is not a failure on its own.
- Answering or approving from here writes to the branch and calls `forbidInTest`-guarded code; Linear, GitHub and T3 calls throw. Prove the panel side here and the outbound text with the regression suites.
