# Settings

The owner's defaults for new jobs (harness, model, where jobs run) and notification settings.

## Sub-features

- `settings-new-jobs` sets `Harness` (`#settings-harness`), `Model` (`#settings-model`) and `Run jobs on` (`#settings-execution`) under `New jobs`.
- `settings-notifications` shows the `Notifications` card.

## How to get to it (user POV)

- Click `Settings` in the sidebar, or open `/settings`.

## Driving it with drive.ts

- **View.** `drive.ts shot /settings settings`. The `.txt` holds `New jobs`, `Harness`, `Model`, `Run jobs on`, `Notifications`.
- **Change a default.** In a journey, open `/settings`, change `Run jobs on` via `page.getByLabel("Run jobs on")`, save, and reload. The reloaded page shows the new value; the settings row on the branch holds it.

## Gotchas

- The harness and model options come from what machines report. With no runner online the lists can be short or empty; record that in the proof rather than seeding fake machines.
