# Task List: Tray Icon Hide/Show

Source spec: `SPEC.md` · Plan: `tasks/plan.md` · Branch: `feat/tray-hide-icon` (fork `superrexy/Cartethyia`)

Verification commands (always through the repository runner, never bare `bun test`):

```
Typecheck:  bun run typecheck
CLI tests:  bun run scripts/test/run.ts --scope scripts
One file:   bun run scripts/test/run.ts --scope scripts test/cli/<file>.test.ts
Build:      bun run build
```

---

## Phase 1 — Foundation

### Task 1: Fork, clone, and branch

**Description:** Create the working copy this feature lives in. Fork `risunCodex/Cartethyia` to
`superrexy/Cartethyia`, clone it to the project directory, wire `origin` to the fork and `upstream` to
the original, create the feature branch from the fork's `main` (3.9.0, `815d49c1`), install
dependencies, and record the baseline so later failures are attributable.

Two full clones already failed on this network (`fetch-pack: unexpected disconnect while reading
sideband packet`, `early EOF`) because the repository is ~63 MB. The clone that succeeded uses a
partial clone (`--filter=blob:none`), which keeps full history and fetches blobs on demand. Keep that
shape: do not re-clone with a plain `git clone`.

**Acceptance criteria:**
- [x] `git -C <clone> remote -v` shows `origin` = `superrexy/Cartethyia` and `upstream` = `risunCodex/Cartethyia`
- [x] Current branch is `feat/tray-hide-icon`, based on `main` at `815d49c1`, working tree clean
- [x] `package.json` version is `3.9.0`
- [x] The four tray sources (`tray.ts`, `tray/index.ts`, `tray/windows.ps1`, `main.ts`) are byte-identical to the 3.9.0 npm package, so the analysis in `SPEC.md` describes this checkout
- [x] `bun install` completed and `bun run typecheck` passes before any edit
- [x] Baseline `--scope scripts` result recorded: **50 pass, 1 skip, 0 fail** (51 tests, 12 files, 699 ms)

**Verification:**
- [x] `git remote -v`, `git status`, `git log --oneline -1` inspected
- [x] `bun run typecheck` passes (exit 0, `tsc --noEmit`)
- [x] `bun run scripts/test/run.ts --scope scripts` → 50 pass / 1 skip / 0 fail
- [x] Manual check: none needed

**Dependencies:** None

**Files likely touched:** none (repository setup only; `SPEC.md` and `tasks/` are added by this plan)

**Estimated scope:** Small — no source files

---

### Task 2: Control channel module

**Description:** Add `scripts/cli/tray/control.ts`, the two-file channel that lets a CLI command ask
a running tray to change visibility and read back what it did. It owns the request file
(`tray-request.json`) and the state file (`tray-state.json`) under `resolveUserConfigDir()`, the
atomic write, the consume-once read, and the liveness rule that a state file whose pid is dead means
"no tray running". Nothing imports it yet, so this task cannot break the running product.

**Acceptance criteria:**
- [x] `writeTrayRequest({ request: "show" | "hide" | "toggle" })` writes `tray-request.json` atomically with mode `0600` and a fresh `nonce`
- [x] `consumeTrayRequest()` returns the request once and unlinks the file; a second call returns `null`
- [x] A corrupt, empty, or unknown-shaped request file is deleted and reported as `null` — never throws
- [x] `writeTrayState({ pid, hidden })` / `readTrayState()` round-trip; a state file whose pid is not alive reads as `null` and is removed
- [x] Missing config directory produces a clear error, not a crash inside `JSON.parse`
- [x] No new dependency; imports are static

**Verification:**
- [x] `bun run scripts/test/run.ts --scope scripts` passes — 60 pass / 1 skip / 0 fail (10 new tests)
- [x] `bun run typecheck` passes (exit 0)
- [x] Manual check: the mode assertion reads `0o600` from the written file; shape asserted field by field

**Note:** the runner always appends the whole `test/cli` tree, so a single file cannot be narrowed
through it. `--scope scripts` is the focused command; it runs in under a second.

**Dependencies:** Task 1

**Files likely touched:**
- `scripts/cli/tray/control.ts` (new)
- `test/cli/tray-visibility.test.ts` (new)

**Estimated scope:** Small — 2 files

---

## Checkpoint A: Foundation

- [ ] `bun run typecheck` passes
- [ ] `bun run scripts/test/run.ts --scope scripts` passes
- [ ] `control.ts` is covered by tests and imported by nothing else yet
- [ ] Review with human before changing tray runtime behavior

---

## Phase 2 — macOS/Linux vertical path

### Task 3: `UnixTray` hide/show/isVisible

**Description:** Give the tray abstraction real visibility on macOS and Linux. `hide()` ends the
`systray2` helper without letting its exit look like a crash, `show()` starts a fresh helper and
re-registers the same rows and click handling, and `isVisible()` reports local state. A small
injectable factory seam lets the tests drive the helper without spawning a real one.

**Acceptance criteria:**
- [x] `Tray` exposes `hide(): Promise<void>`, `show(): Promise<void>`, `isVisible(): boolean`; `close()` still removes the icon and ends the helper
- [x] `hide()` calls the helper with `kill(false)` and does not call `process.exit`
- [x] The helper's `exit` event fired during `hide()` does not reach `onExit`; an exit outside `hide()` still does
- [x] `show()` after `hide()` creates a new helper and a click on a row still resolves to the same `id` (including hide → show → hide → show)
- [x] `hide()` on an already-hidden tray and `show()` on an already-visible tray are no-ops
- [x] `isVisible()` is `false` after `hide()` and `true` after `show()`

**Verification:**
- [x] `bun run scripts/test/run.ts --scope scripts` passes — 67 pass / 0 fail (7 new tests)
- [x] `bun run typecheck` passes (exit 0)
- [x] Manual check: none yet (no caller)

**Deviation:** `WindowsTray` implements `hide()`/`show()` in this task too, together with the
`windows.ps1` actions. The interface cannot gain three members without every implementation
compiling, and shipping a Windows path that silently does nothing would be worse than shipping the
real one early. Task 6 therefore owns the Windows protocol tests rather than the implementation.

**Dependencies:** Task 1

**Files likely touched:**
- `scripts/cli/tray/index.ts`
- `test/cli/tray-visibility.test.ts`

**Estimated scope:** Small — 2 files

---

### Task 4: Tray menu row, request loop, and `carte tray` subcommands

**Description:** Wire the feature into the running product: a `Hide icon` row in the tray menu, a
1 s request loop beside the health poll that applies `hide`/`show`/`toggle` and rewrites the state
file, state cleanup on `Exit`, and the `carte tray hide|show|toggle|status` subcommands that write a
request and wait for the state file to confirm it.

**Acceptance criteria:**
- [x] Tray menu shows `Hide icon` between `Backup` and `Exit`; clicking it removes the icon within 2 s
- [x] While hidden, the tray process stays alive and `GET /health` still answers 200
- [x] `carte tray show` restores the icon within 2 s; `carte tray toggle` flips it; `carte tray status` prints `icon hidden` / `icon visible` with the tray pid
- [x] `carte tray hide` with no tray running prints a clear message and exits non-zero without leaving a request file
- [x] `hide`/`show`/`toggle`/`status` never drain, stop, or restart the gateway, and never write `controller.json`
- [x] `Exit` stops the gateway as before and removes `tray-state.json` and any pending `tray-request.json`
- [x] No dynamic import is added in `scripts/cli` without the documented comment shape

**Verification:**
- [x] `bun run scripts/test/run.ts --scope scripts` passes — 76 pass / 0 fail
- [x] `bun run typecheck` passes (exit 0)
- [x] Manual check on macOS, isolated instance (own config dir, data dir, PORT=12990) so the
      operator's tray was never touched: hide → icon gone, helper count 1 (only the operator's),
      `/health` 200, `status` reports hidden; show → helper count 2, `status` visible; toggle both
      ways; `/health` 200 throughout
- [x] Manual check: `carte tray hide` with no tray running → `No Cartethyia tray is running; start one
      with carte --tray`, exit 1, config dir left empty; `tray status` with no tray → exit 0
- [x] Manual check: killing the tray removed `tray-state.json` and `controller.json` and left the
      gateway stopped, as `Exit` should

**Not automated:** the menu-row click itself needs UI scripting (Accessibility permission). The row
and its handler are verified by inspection (`id: "hide"` row at the documented position, `handleSelect`
branch), and the handler's body is the same `setVisibility` path the CLI verification exercised.

**Dependencies:** Tasks 2, 3

**Files likely touched:**
- `scripts/cli/tray.ts`
- `scripts/cli/main.ts`
- `test/cli/tray-visibility.test.ts`

**Estimated scope:** Medium — 3 files

---

## Checkpoint B: The feature works on macOS

- [ ] Icon hides and returns from the menu row and from `carte tray`
- [ ] Gateway uninterrupted throughout (`/health` 200, no drain in the log)
- [ ] `Exit` still stops everything and leaves no state files
- [ ] Review with human before Windows parity

---

## Phase 3 — Parity and close-out

### Task 5: `carte --tray` shows the icon when a tray is already running

**Description:** Turn the current already-running error into the discoverable way back. When the
live controller owner is a tray, `carte --tray` writes a `show` request, reports it, and exits 0. A
live menu owner keeps the existing error, and the menu→tray handoff path is untouched.

**Acceptance criteria:**
- [x] `carte --tray` with a hidden tray running prints an already-running line, exits 0, and the icon returns
- [x] Exactly one tray process exists afterwards (`pgrep -f "main.ts tray"` returns one pid)
- [x] `carte --tray` while a menu owns the controller still fails with the existing message
- [x] The menu's `Hide to Tray` handoff still works end to end

**Verification:**
- [x] `bun run scripts/test/run.ts --scope scripts` passes — 81 pass / 0 fail (5 new tests)
- [x] `bun run typecheck` passes (exit 0)
- [x] Manual check on macOS, isolated instance: `tray hide` → icon hidden → `carte --tray` printed
      `Cartethyia tray is already running; icon shown.`, exit 0, one tray process, helper count back
      to 2, `status` reports visible, `/health` 200
- [x] Manual check: the menu-owned and no-controller cases return `false` and fall through to the
      normal start path (unit-tested); the `Hide to Tray` handoff is untouched — `inheritedControllerHandoff()`
      is checked first and the handoff tests in `test/cli/controller.test.ts` still pass

**Note:** the menu-owns-the-controller error was not re-demonstrated by hand, because doing so means
starting a menu against the isolated instance and leaving it attached. It is covered by the
`showIconOnExistingTray` unit test plus the unchanged `acquireController` path.

**Dependencies:** Task 4

**Files likely touched:**
- `scripts/cli/main.ts`
- `scripts/cli/controller.ts`
- `test/cli/tray-visibility.test.ts`

**Estimated scope:** Small — 3 files

---

### Task 6: Windows visibility via the PowerShell NotifyIcon

**Description:** Add `hide`/`show` actions to the Windows helper protocol and implement
`WindowsTray.hide()`/`show()` on top of them with an ack. The helper keeps running and only toggles
`NotifyIcon.Visible`, so the message loop and the menu survive.

**Acceptance criteria:**
- [x] `windows.ps1` handles `{"action":"hide"}` and `{"action":"show"}`, toggles `$script:notifyIcon.Visible`, and writes `{"type":"hidden"}` / `{"type":"shown"}`
- [x] `WindowsTray.hide()`/`show()` send the action and resolve on the ack; a missing ack rejects after the timeout instead of reporting success
- [x] `isVisible()` tracks the last acknowledged state
- [x] `kill` still disposes the icon and ends the message loop
- [x] The protocol comment block at the top of `windows.ps1` documents the new actions and events

**Verification:**
- [x] `bun run scripts/test/run.ts --scope scripts` passes — 87 pass / 0 fail (6 new tests)
- [x] `bun run typecheck` passes (exit 0)
- [ ] Manual check: **not possible on this machine** — stated explicitly in the final report

**Bug found and fixed:** `WindowsTray.close()` set `#closed = true` before calling `#send()`, and
`#send()` returns early when `#closed` is set — so the helper never received `kill` and was only
removed by the 1.5 s timeout's `process.kill()`. The `kill` is now sent before the flag is set, which
lets the helper dispose its icon and exit on its own. Found by the `windows kill still disposes the
icon` test, which asserted on the last command sent rather than on the process dying.

**Dependencies:** Tasks 3, 4

**Files likely touched:**
- `scripts/cli/tray/windows.ps1`
- `scripts/cli/tray/index.ts`
- `test/cli/tray-visibility.test.ts`

**Estimated scope:** Small — 3 files

---

### Task 7: Documentation and final verification

**Description:** Document the new commands and the menu row where operators look for CLI behavior,
then run the full gate and write the report: what changed, what ran, what passed, what could not be
verified on this machine.

**Acceptance criteria:**
- [x] README CLI section lists `carte tray hide|show|toggle|status` and the `Hide icon` row, and states that hiding keeps the gateway running
- [x] The existing `carte --tray` description notes the already-running behavior
- [x] All repository artifacts added by this work are in English
- [x] `SPEC.md` stays the source of truth for the shipped behavior (update only if an implemented detail diverges, and say so in the report)

**Verification:**
- [x] `bun run typecheck` passes (exit 0)
- [x] `bun run scripts/test/run.ts --scope scripts` passes — 87 pass / 1 skip / 0 fail (88 tests, 13 files)
- [x] `bun run build` succeeds: dashboard build, AOT manifest, and `dist/cartethyia` compiled
- [x] Final report lists every check with its outcome and every unverified platform

**Spec updates folded in:** `Status:` moved to `implemented`; the state record's `nonce` field and the
`UnixTray.hide()` failure rule were added, because the implementation found two things the spec's
first draft got wrong — timestamps cannot attribute an ack, and a swallowed `kill()` error could
report a hidden icon that was still on screen.

**Observed, not changed:** `dist/cartethyia` boots the gateway even for `--help`. That binary is the
gateway, not the CLI; the CLI entry point is `scripts/cli/main.ts` (and the packaged
`scripts/cli/bin/cartethyia.cjs`). Pre-existing and unrelated to this work.

**Dependencies:** Tasks 4, 5, 6

**Files likely touched:**
- `README.md`
- `documentation/reference/configuration.md` (only if it documents the CLI/tray behavior)
- `SPEC.md` (only if a shipped detail diverged)

**Estimated scope:** Small — 1-3 files

---

## Checkpoint C: Complete

- [ ] Every acceptance criterion above is met or explicitly reported as unverified
- [ ] `bun run typecheck` and the CLI test scope are green
- [ ] macOS end-to-end demonstrated; Windows/Linux implemented and unit-tested only
- [ ] Nothing pushed; branch local, working tree clean
