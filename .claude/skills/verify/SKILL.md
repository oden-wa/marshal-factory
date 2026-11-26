---
name: verify
description: Drive the Marshal Factory supervision panel (Next.js, Neon Auth) the way the owner does and capture screenshot, text and ARIA evidence. Runs the panel locally against a disposable Neon branch copied from production data, signed in as a throwaway owner. Use to prove a panel change (run detail pane, inbox, board, settings) or any text the owner reads there, before calling it done.
---

# Verify the Marshal Factory panel

The panel is the only surface this skill drives. Slack, Linear, GitHub and T3 output is not drivable here: the stack sets `FACTORY_TEST_BRANCH_ID`, so `forbidInTest` (`lib/test-mode.ts`) makes those calls throw instead of reaching production. Prove those with the `scripts/*-regressions.ts` suites (`bun run test:regressions <prefix>`), which assert the exact text sent.

The runner daemon (`runner/`) is not started. Rows the panel shows come from the branch's copy of production data, frozen at `up` time.

## Launch

Run from the checkout you want to verify (a worktree, never the main checkout: `drizzle.config.ts` loads `.env.local`, which points at production, so `up` refuses when one exists). Needs `bun install` done, the `neon` CLI signed in, and Google Chrome.

```bash
bun .claude/skills/verify/scripts/stack.ts up
```

`up` creates the Neon branch `verify-<time>-<pid>` from `main` (expires after 2 h), migrates it to this checkout's schema, creates the owner `verify-owner-<random>@example.com` as an admin in that branch's own Neon Auth, so public sign-up stays closed, with a password generated per stack (kept only in the `0600` state file, which `drive.ts` signs in from) and marks the address verified, then starts `next dev` on `localhost:3007` only (`VERIFY_PORT` to change the port). Linux only, since it identifies the server by its `/proc` start time. Ready is the line `ready: http://localhost:3007`; it waits until `/auth/sign-in` renders, which takes 20 to 60 s on a cold `.next`. Realtime is off (`VERCEL_ENV=preview`), so the footer reads "Live updates off in previews" and pages show data as of load.

Port 3007 is the one production Realtime allows for local work (`neon.ts`). Two checkouts can each run a stack on different ports; state lives per checkout under `~/.cache/marshal-factory-verify/stacks/<hash>/`.

## Doctor

```bash
bun .claude/skills/verify/scripts/stack.ts doctor
```

Read-only. Checks the `next dev` process this checkout started is alive, `/auth/sign-in` answers 200, `/` without a session redirects (307), the Neon branch still exists, and the recorded `DATABASE_URL` points at that branch's endpoint. Any `FAIL` line means `down` then `up`. The server log is `~/.cache/marshal-factory-verify/stacks/<hash>/next-dev.log`.

## Drive

`scripts/drive.ts` signs in through the real form and captures evidence. One page:

```bash
bun .claude/skills/verify/scripts/drive.ts shot "/?view=list&run=mcp%3Afactory%2FFAC-2" run-detail-fac2
```

It prints the evidence dir. The first run installs `playwright-core` into `~/.cache/marshal-factory-verify/tools` (not the repo). For a journey with clicks, import `openPanel` in a scratch script outside the repo:

```ts
import { openPanel } from "<repo>/.claude/skills/verify/scripts/drive.ts";
const { page, base, shot, close } = await openPanel("inbox-answer");
await page.goto(`${base}/inbox?job=FAC-3`);
await shot("before");
await page.getByRole("list", { name: "Needs you" }).getByRole("link").first().click();
await shot("after", page.getByRole("heading", { level: 2 }));
await close();
```

`shot` waits for every `aria-busy="true"` and `data-slot="skeleton"` loader to leave before capturing, and fails when the browser ended up on another origin or back on `/auth`. Requests to any other `localhost` port, redirect hops included, fail with `ERR_BLOCKED_BY_CLIENT`, because cookies are not port-scoped and would carry the owner's session there. After a click, pass a locator for what the new screen shows as the second argument: `networkidle` can already hold for the old screen. Handles are the visible English labels, `aria-label`s and route paths; the feature files list them per screen. The context runs with locale `ja-JP`, so dates render as an owner in Japan sees them.

To set up a precondition, write rows to the branch, never to production. `stack.ts sql` runs one statement on the branch and prints each row as JSON. It connects from the state file, so the password never shows in `ps`, and it fails when no stack is up rather than falling back to a `DATABASE_URL` in your shell:

```bash
bun .claude/skills/verify/scripts/stack.ts sql "update runs set question = 'テスト' where session_id = 'mcp:factory/FAC-2'"
```

`stack.ts env` prints the branch's `DATABASE_URL` and friends as `export` lines, for a tool that reads them from the environment.

## Evidence

Each `shot` writes `<label>.png` (full page), `<label>.txt` (URL, then the page's visible text) and `<label>.aria.yml` (ARIA snapshot) under `~/.cache/marshal-factory-verify/evidence/<time>-<journey>/`. For a text change, grep the `.txt` for the new string and for the old one, and look at the PNG for layout. For an action, capture before and after, and check the row it should change with `psql "$DATABASE_URL_UNPOOLED"` after `eval`ing `stack.ts env`. Drive the real route and the real buttons, never an internal setter. A string that only Slack, Linear, GitHub or T3 receives is proved by its regression suite, not here.

## Cleanup

```bash
bun .claude/skills/verify/scripts/stack.ts down
```

Stops the `next dev` process group this checkout started (never by name) and deletes the Neon branch. Evidence under `~/.cache/marshal-factory-verify/evidence/` is kept. A branch `down` could not delete expires 2 h after `up`. Run `down` after a failed `up` too: state is written before anything can fail.

## Features

`features/README.md` indexes the screens with their routes, handles and proofs.
