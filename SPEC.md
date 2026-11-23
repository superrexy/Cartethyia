# Spec: Tray Icon Hide/Show — V1

Status: implemented
Repository: `superrexy/Cartethyia` (fork of `risunCodex/Cartethyia`), branch `feat/tray-hide-icon`

## Objective

Give the Cartethyia system tray the ability to remove its own menu bar / notification-area icon
without stopping the gateway, and to bring the icon back on demand.

Today the tray icon is the only interactive surface for a backgrounded gateway, and the only ways
out of it are destructive: `Exit` stops the gateway, and killing the helper makes the tray close the
gateway too. An operator who wants the gateway running but the menu bar clean has no option.

The feature is for the operator running Cartethyia on their own machine (macOS menu bar, Windows
notification area, Linux tray). Success means: the icon disappears within ~2 s of the request, the
gateway keeps answering `/health`, and a documented command brings the icon back.

### Capability map

| Module id | Responsibility | Depends on |
|---|---|---|
| `fork-setup` | Create `superrexy/Cartethyia` from upstream `main`, wire `origin`/`upstream`, create the feature branch, keep the working tree clean | — |
| `tray-visibility` | `hide`/`show` on the tray abstraction, per-platform implementation, control channel, CLI subcommands, tray menu row, tests, docs | `fork-setup` |

Build order: `fork-setup` → `tray-visibility`.

Interfaces between the modules are limited to: the fork's default branch state, the branch name,
and the remotes. `tray-visibility` never touches upstream configuration.

## Tech Stack

- Bun 1.4.0 (runtime and package manager, per `package.json` `engines.bun`)
- TypeScript 5.9.2, `strict` (do not weaken)
- `systray2` 2.1.4 — macOS/Linux tray helper (prebuilt binary; no source changes possible)
- Windows: PowerShell `System.Windows.Forms.NotifyIcon` driven over JSON lines
- No new dependencies

Verified on this machine before speccing (isolated probe, no gateway involved):

```
ready(pid 67904) → kill(false) → helper exitCode 0, parent still alive → new SysTray → ready(pid 67946)
```

So on macOS/Linux, "hide" = exit the `systray2` helper while the parent process keeps running, and
"show" = construct a fresh `SysTray`. The gateway process is never involved.

## Commands

```
Install deps:      bun install
Typecheck:         bun run typecheck
Full test suite:   bun run test
CLI tests:         bun run scripts/test/run.ts --scope scripts
Single new test:   bun run scripts/test/run.ts --scope scripts test/cli/tray-visibility.test.ts
Lint:              (no linter configured in this repository)
Build package:     bun run build
Run the fork's CLI without installing:
                   bun /Users/bintangrezeka/Documents/Projects/My-Projects/Cartethyia-fork/scripts/cli/main.ts <command>
```

`bun run test` and `--scope backend` need `CARTETHYIA_TEST_DATABASE_URL`. `--scope scripts` runs
`test/cli` alone and does not touch the database, so it is the gate for this change. The full suite is run once at the end if
a disposable database is already available, otherwise the limitation is reported.

## Project Structure

Existing layout (unchanged):

```
src/                 → gateway, console API, providers (not touched by this change)
dashboard/           → React console (not touched)
scripts/cli/         → CLI, menu, tray, controller, autostart
scripts/cli/tray/    → platform tray implementations + assets
test/cli/            → CLI unit/integration tests (bun:test)
documentation/       → architecture/configuration/feature docs
```

Files this change adds or edits:

```
scripts/cli/tray/control.ts          MOVED  → src/console/tray/control.ts (V1.1: shared with the console)
scripts/cli/tray/index.ts            EDIT Tray interface gains hide()/show()/isVisible()
scripts/cli/tray/windows.ps1         EDIT "hide"/"show" protocol actions, "hidden"/"shown" acks
scripts/cli/tray.ts                  EDIT menu row, request poll loop, state writes, gateway untouched
scripts/cli/main.ts                  EDIT `tray hide|show|toggle|status` dispatch + HELP text
scripts/cli/controller.ts            EDIT read-only controller summary for the auto-show path
test/cli/tray-visibility.test.ts     NEW  unit tests for control channel and visibility state machine
test/console/tray-routes.test.ts     NEW  V1.1 route contract (gates, nonce confirmation, errors)
dashboard/src/features/settings/TrayPanel.tsx  NEW  V1.1 Settings → Tray panel
dashboard/test/features/tray-panel.test.tsx    NEW  V1.1 panel states and toasts
README.md                            EDIT CLI table: hide/show usage
SPEC.md                              this spec
```

## Design

### Control channel (`src/console/tray/control.ts`)

Two files in `resolveUserConfigDir()` (mode `0600`), next to `controller.json`:

- `tray-request.json` — written by a CLI command, consumed once by the running tray:
  `{ "request": "show" | "hide" | "toggle", "nonce": "<uuid>", "requestedAt": "<ISO>" }`
- `tray-state.json` — written by the tray on every visibility change and on startup:
  `{ "pid": <number>, "hidden": <boolean>, "updatedAt": "<ISO>", "nonce"?: "<uuid>" }`

  `nonce` is the request this record answers, copied from `tray-request.json`. It is what lets a
  command tell its own answer from the state that was already there: timestamps cannot, because a
  tray acting inside the same millisecond as the request produces an identical record, which made
  `toggle` report a failure for a change that had happened.

Rules:

- A corrupt, empty, or unknown-shaped file is ignored and deleted, never thrown on. A tray must not
  die because a hand-edited file is malformed.
- The tray polls the request file every 1 000 ms, applies at most one request per poll, then unlinks
  it. The write is atomic (temp file + `rename`) so a poll never reads a half-written request.
- `status` treats a state file whose `pid` is dead as "no tray running" and deletes it.
- Requests are not persisted: a request written while no tray runs is answered by the CLI
  ("no tray is running") and not queued.

### Tray abstraction (`scripts/cli/tray/index.ts`)

```ts
export interface Tray {
  ready(): Promise<void>;
  update(id: string, title: string, enabled?: boolean): void;
  setTooltip(text: string): void;
  /** Removes the icon. The process, the menu model and the gateway stay alive. */
  hide(): Promise<void>;
  /** Puts the icon back, re-registering the same rows and click handling. */
  show(): Promise<void>;
  isVisible(): boolean;
  /** Removes the icon and ends the helper. */
  close(): Promise<void>;
}
```

- `UnixTray`: keeps the original `TrayOptions` so `show()` can rebuild the `SysTray` instance and
  re-register `onClick`. While hiding, the helper's `exit` event must not reach `onExit` — otherwise
  `tray.ts` would close the gateway. A `#hiding` flag guards that listener; a helper that exits on
  its own still reports `onExit`.
- `WindowsTray`: sends `{"action":"hide"}` / `{"action":"show"}` and waits for the `hidden`/`shown`
  ack with a 2 s timeout; a missing ack rejects so the caller can report a failure instead of
  pretending the icon changed. The PowerShell helper keeps running and only toggles
  `notifyIcon.Visible`.
- `UnixTray.hide()` reports a failure to end the helper rather than swallowing it, so a hide cannot
  claim the icon is gone while the helper that draws it still runs. `close()` tolerates the same
  error, because shutdown has nothing left to prove.
- `isVisible()` is local state, not a probe; it is what `tray-state.json` records.

### Tray runtime (`scripts/cli/tray.ts`)

- New menu row `{ kind: "action", id: "hide", title: "Hide icon" }` between `Backup` and `Exit`.
- A second loop next to the health poll consumes the request file and calls `hide()`/`show()`, then
  rewrites `tray-state.json`.
- `hide`/`show` must never call `stopGateway`, `stopAttachedGateway`, `close`, or touch the
  controller lease. The gateway is `detached: true`; nothing about visibility may reach it.
- On `Exit`, the state file is removed and the pending request is deleted.

### CLI (`scripts/cli/main.ts`)

```
carte tray                 start the tray (unchanged)
carte tray hide            remove the icon, keep the gateway running
carte tray show            bring the icon back
carte tray toggle          flip the current state
carte tray status          print "running (PID n), icon hidden|visible" or "no tray running"
```

- `hide`/`show`/`toggle` wait up to 3 s for the state file to confirm the change, then print a
  one-line result; on timeout or when no tray is running they print a one-line explanation and exit
  non-zero.
- `status` exits 0 in both cases.

### `carte --tray` when a tray already runs

`acquireController("tray")` currently throws `Cartethyia is already controlled by a tray (PID n)`.
With this change, a live **tray** owner is treated as "show the icon": write a `show` request, print
`Cartethyia tray is already running; icon shown.`, exit 0. A live **menu** owner keeps the existing
error, and the menu→tray handoff path (`inheritedControllerHandoff()`) is untouched.

### Console Settings panel (V1.1 delta — `SPEC-console-tray-control.md`)

The same control from the dashboard, through the same file channel:

- `src/console/tray/control.ts` owns the channel (moved from `scripts/cli/tray/control.ts`) and the
  nonce-confirmation wait (`awaitTrayChange`), so the CLI and the console cannot disagree about what
  "confirmed" means.
- `GET /console/api/tray/status` → `{ running, hidden, pid }`; `POST /console/api/tray/visibility`
  with `{ action: "hide" | "show" }`. Both are `platform:admin`; the POST also requires a loopback
  peer (`tray_control_local_only` otherwise) because a remote browser has no tray to talk to.
  Errors: `tray_not_running` 409, `tray_control_unavailable` 409 (gateway started without a config
  dir), `tray_visibility_timeout` 504. Asking for the state the tray is already in is answered from
  the record without writing a request.
- Dashboard: Settings → **Tray** (`dashboard/src/features/settings/TrayPanel.tsx`), one card, no new
  route.
- `pidAlive` and `isLoopbackPeer` now live in `src/shared/` so `src/` imports neither `scripts/` nor
  the transport layer.

## Code Style

Match the repository: explicit return types, `readonly` fields, `#private` members, comments that
state *why* (not what), and no `any` or suppressions.

```ts
/** Whether the icon is on screen. Local state: the helper reports no visibility. */
#visible = true;

async hide(): Promise<void> {
  if (!this.#visible) return;
  this.#visible = false;
  // `false`: systray2 otherwise calls `process.exit(0)` when the helper exits,
  // which would take the gateway's only UI process down with the icon.
  this.#hiding = true;
  try {
    await this.#tray.kill(false);
  } finally {
    this.#hiding = false;
  }
}
```

All repository artifacts (comments, docs, commit messages) are written in English.

## Testing Strategy

- Framework: `bun:test`, run through `scripts/test/run.ts` (never bare `bun test`).
- Location: `test/cli/tray-visibility.test.ts`; existing `test/cli/*.test.ts` must stay green.
- Isolation: `CARTETHYIA_CONFIG_DIR` points at an `mkdtempSync` directory per test, as
  `test/cli/controller.test.ts` already does.
- Levels:
  - Unit — control channel: write/consume/unlink, corrupt file ignored, dead-pid state read as "no tray",
    atomic replace under a concurrent reader.
  - Unit — visibility state machine over a fake `Tray` (records calls, reports `isVisible()`):
    hide → hidden, show → visible, toggle twice → back to visible, `close()` while hidden.
  - Unit — `WindowsTray` command payloads: `hide`/`show` JSON shape and ack timeout rejection,
    using an injected spawn/fake child process.
  - Manual (macOS, this machine) — the real end-to-end path, listed under Success Criteria.
- No coverage threshold is enforced by this repository; the new module must be fully exercised by the
  unit tests above.
- Windows and Linux behavior is implemented but **not verifiable on this machine**; the report will
  say so explicitly rather than claim it passed.

## Boundaries

- **Always**
  - Keep hide/show out of the gateway lifecycle: no drain, no stop, no controller changes.
  - Use `scripts/test/run.ts` for verification; run `bun run typecheck` before reporting.
  - Write English in every repository artifact.
  - Write control/state files with mode `0600` under the resolved config dir.
  - Keep the tray helper's own exit (crash) still closing the tray, so a dead helper is not
    silently reported as "hidden".
- **Ask first**
  - Installing the fork globally (`bun install -g`, `bun link`) — this would shadow the 3.9.0 install.
  - Stopping the currently running tray/gateway on this machine for a manual test.
  - Pushing the branch, opening a PR, or touching `upstream`.
  - Adding a dependency (target: none needed).
  - Any change outside `scripts/cli/`, `test/cli/`, `README.md`, `SPEC.md`.
- **Never**
  - `git reset --hard`, `git clean`, `git checkout --`, or force-push.
  - Edit `dist/`, `node_modules/`, or `vendor/` by hand.
  - Commit secrets, tokens, or the drain token.
  - Implement hide by killing the gateway, the tray process, or the controller lease.
  - Silence a failure by widening a type, catching and ignoring, or removing a test.

## Success Criteria

1. `bun run typecheck` passes.
2. `bun run scripts/test/run.ts --scope scripts` passes, including the new test file.
3. macOS manual, with the fork's CLI: tray started, `Hide icon` clicked →
   a. the icon leaves the menu bar within 2 s,
   b. the tray process is still alive and `GET /health` still answers 200,
   c. `carte tray status` prints `icon hidden`.
4. `carte tray show` → icon returns within 2 s, `carte tray status` prints `icon visible`, and the
   tray menu still works (a click on `Open Console` opens the dashboard).
5. `carte --tray` while the icon is hidden → prints the already-running line, exits 0, icon visible,
   exactly one tray process (`pgrep -f "main.ts tray"`).
6. `carte tray hide` with no tray running → clear message, exit code non-zero, no files left behind.
7. `Exit` from the tray menu still stops the gateway and leaves no `tray-state.json` or
   `tray-request.json` behind.
8. `carte start`, `carte stop`, `carte menu`, and `cartethyia autostart` behave exactly as before.
9. Windows and Linux code paths exist, compile, and are covered by unit tests; the report states they
   were not run on those platforms.

## Out of Scope (Deferred)

- Global keyboard shortcut to toggle the icon — needs an extra dependency and macOS Accessibility
  permission.
- Auto-show timer (`carte tray hide --for 30m`).
- Persisting "hidden" across restarts / starting hidden (`carte --tray --hidden`).
- Hiding other apps' icons or integrating with Ice/Bartender/Hidden Bar.
- macOS template-icon/dark-mode variants.
- Pushing the branch to the fork or opening a PR to upstream (this version stays local).

## Open Questions

None blocking. Assumptions recorded for the reviewer:

1. Clone lives at `/Users/bintangrezeka/Documents/Projects/My-Projects/Cartethyia-fork`
   (`origin` = fork, `upstream` = `risunCodex/Cartethyia`); feature work happens on
   `feat/tray-hide-icon`.
2. "Hide icon" means the status item / notification-area icon only; the tray process keeps running so
   `carte tray show` can bring it back without re-adopting the gateway.
3. Manual macOS verification may require stopping the tray that is running on this machine today,
   which also stops its gateway — that is asked for before it happens.
