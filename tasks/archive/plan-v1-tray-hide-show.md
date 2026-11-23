# Implementation Plan: Tray Icon Hide/Show

Source spec: `SPEC.md`

## Overview

Add a non-destructive way to remove the Cartethyia tray icon and put it back. Today the icon is the
only interactive surface for a backgrounded gateway and every exit from it is destructive: `Exit`
stops the gateway, and killing the helper makes the tray close the gateway. This plan delivers a
`Hide icon` menu row plus `carte tray hide|show|toggle|status`, a file-based control channel between
CLI and tray, per-platform visibility on top of `systray2` (macOS/Linux) and the PowerShell
NotifyIcon (Windows), and the tests and docs that keep it honest.

Work happens in a fresh clone of `superrexy/Cartethyia` (fork of `risunCodex/Cartethyia` at 3.9.0,
`815d49c1`) on branch `feat/tray-hide-icon`. Nothing is pushed.

## Architecture Decisions

1. **Visibility is a tray concern, never a gateway concern.** The gateway is already spawned
   `detached: true` (`scripts/cli/tray.ts`). Hiding only removes the icon; no code path added by
   this change may call `stopGateway`, `stopAttachedGateway`, `close()`, or touch the controller
   lease. This is the difference between the feature and the existing `Exit`.
2. **Hide = end the helper, show = start a new one (macOS/Linux).** `systray2` exposes no
   visibility control and its helper binary cannot be rebuilt here. A probe on this machine proved
   the pattern works: `kill(false)` exits the helper while the parent keeps running, and a fresh
   `SysTray` re-registers the icon. The alternative — patching or vendoring the helper — is out of
   scope.
3. **Windows keeps one helper and toggles `NotifyIcon.Visible`.** The PowerShell helper already owns
   the icon and its message loop; killing it would end `Application::Run()` and the tray with it.
4. **The helper's own exit must still be fatal.** `UnixTray` registers `onExit` so a crashed helper
   closes the tray. Hide temporarily suppresses that listener, or hiding would look like a crash and
   close the gateway — the exact failure this feature must avoid.
5. **Control channel is two small JSON files in the config dir**, polled every 1 s: a request the
   tray consumes and unlinks, and a state file the tray rewrites on every change. No sockets, no
   ports, no new dependencies, and it works from any terminal — including one that is not the tray's
   parent. Writes are atomic (temp + rename) and files are mode `0600`.
6. **Corrupt state is ignored, never thrown on.** A hand-edited or truncated file must not kill a
   running tray; it is deleted and treated as absent.
7. **`carte --tray` while a tray runs becomes "show the icon".** Reusing the existing
   already-running detection is the cheapest discoverable way back for an operator who does not know
   `carte tray show`. A live *menu* owner keeps the current error, and the menu→tray handoff is
   untouched.

## Dependency Graph

```
Task 1  fork-setup (clone, remotes, branch, bun install, baseline green)
   │
   ├──► Task 2  control channel (tray/control.ts)
   │        │
   │        └──► Task 4  tray loop + CLI subcommands ──► Task 5  carte --tray auto-show
   │                 ▲                                        │
   └──► Task 3  UnixTray hide/show ───────────────────────────┘
                    │
                    └──► Task 6  Windows parity
                             │
                             └──► Task 7  docs + final verification
```

`Task 3` needs only the branch; `Task 4` needs both `2` and `3`; `Task 6` reuses the interface `3`
settles; `Task 7` closes after `4`, `5`, and `6`.

## Task List

### Phase 1 — Foundation

- [x] Task 1: Fork, clone, and branch
- [x] Task 2: Control channel module

#### Checkpoint A: Foundation

- [x] `bun run typecheck` passes on a clean checkout
- [x] `bun run scripts/test/run.ts --scope scripts` passes
- [x] Control channel tests pass and the module is imported by nothing yet
- [x] Review with human before touching the tray runtime (the `/build auto` approval covered it)

### Phase 2 — macOS/Linux vertical path

- [x] Task 3: `UnixTray` hide/show/isVisible
- [x] Task 4: Tray menu row, request loop, and `carte tray` subcommands

#### Checkpoint B: The feature works on macOS

- [x] Icon disappears and returns from `carte tray hide` / `carte tray show`
- [x] Gateway keeps answering `/health` throughout
- [x] `carte tray status` reflects reality
- [x] Review with human before Windows parity (autonomous mode: continued)

### Phase 3 — Parity and close-out

- [x] Task 5: `carte --tray` shows the icon when a tray is already running
- [x] Task 6: Windows visibility via the PowerShell NotifyIcon
- [x] Task 7: Documentation and final verification

#### Checkpoint C: Complete

- [x] All acceptance criteria met
- [x] Full CLI scope green (87 pass / 1 skip / 0 fail), typecheck green, build green
- [x] Windows/Linux paths compiled and unit-tested; explicitly reported as not run on those OSes
- [x] Ready for review

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Hide suppresses `onExit`, so a helper that crashes while hidden is mistaken for a normal hide | High — icon vanishes with no way back except a CLI command | Suppress only during the awaited `kill()` call (`#hiding` flag cleared in `finally`); a later helper exit still reports `onExit` |
| `systray2.kill(false)` resolves on the helper's `exit`, and a helper that already exited would hang `close()` | Med — shutdown hang | Reuse the existing `exitCode`/`signalCode` guard in `UnixTray.close()`; `hide()` uses the same pattern |
| Re-registering rows on `show()` loses the `__id` numbering, so clicks map to the wrong action | Med — wrong action fires | `show()` rebuilds the `#items` map through the same path as the constructor; a test asserts a click after show/hide/show resolves to the right id |
| A request file written by an older/newer CLI is unknown-shaped | Low | Unknown `request` values are deleted and ignored; state file shape is validated field by field |
| Polling every 1 s keeps the process busy or delays `Exit` | Low | One `readFileSync` + `unlinkSync` per second; the loop yields with `Bun.sleep` and exits with `closing` |
| Manual macOS verification requires stopping the tray that is running on this machine (and its gateway) | Med — interrupts the operator | Ask before stopping it; `carte start` restores service |
| Windows behavior is unverifiable here | Med — ships untested on one platform | Unit tests on the command payloads and ack timeout; report states plainly it was not run on Windows |
| `test/cli/no-dynamic-imports-in-shipped.test.ts` rejects a new dynamic import in `scripts/cli` | Low | Use static imports in new modules; the CLI dispatch entry in `main.ts` follows the existing `// dynamic-import:` pattern |

## Open Questions

None blocking. Assumptions carried from the spec:

1. Clone path `/Users/bintangrezeka/Documents/Projects/My-Projects/Cartethyia-fork`, `origin` = fork,
   `upstream` = `risunCodex/Cartethyia`.
2. "Hide" means the status item / notification-area icon only; the tray process keeps running.
3. Manual macOS verification may require stopping the currently running tray; permission is asked
   first.
