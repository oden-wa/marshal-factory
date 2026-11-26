# Marshal Factory panel verification map

This directory is the maintained source for verifying what the owner sees in the panel. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- `bun .claude/skills/verify/scripts/stack.ts up` has printed `ready:` for this checkout, and `stack.ts doctor` prints no `FAIL`.
- The branch holds a copy of production rows as of `up`: jobs `FAC-1` to `FAC-5`, their runs, inbox items and settings. Look up keys and session ids on the branch (`eval "$(bun .claude/skills/verify/scripts/stack.ts env)"`, then `psql "$DATABASE_URL_UNPOOLED"`) rather than assuming them.
- Never point a drive at production or at a stack another checkout started.

## Driving conventions

- Sign in only through `openPanel` (or `drive.ts shot`), which uses the real `/auth/sign-in` form.
- Address screens by route path and query, and controls by role plus visible label or `aria-label`.
- Capture with `shot`, which waits out skeleton loaders. Capture before and after every action.
- Changes that write rows (merge, stop, answer, settings save) land on the branch only. Check the row afterwards.

## Features

| Feature | File | Route |
| --- | --- | --- |
| Run detail pane | [run-detail.md](run-detail.md) | `/?view=list&run=<session_id>` |
| Inbox | [inbox.md](inbox.md) | `/inbox`, `/inbox?job=<key>` |
| Jobs board and list | [jobs.md](jobs.md) | `/`, `/?view=list` |
| Settings | [settings.md](settings.md) | `/settings` |

Not covered yet: `/activity`, `/machines`, `/repositories`, the `New job` dialog.
