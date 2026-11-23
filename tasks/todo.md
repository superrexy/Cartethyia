# Task List: Console Tray Icon Control

Source spec: `SPEC-console-tray-control.md` · Plan: `tasks/plan.md` · Branch: `feat/tray-hide-icon`

Verification commands (through the repository runner, never bare `bun test` at the root):

```
Typecheck:            bun run typecheck
Dashboard typecheck:  bun run dashboard:typecheck
CLI tests:            bun run scripts/test/run.ts --scope scripts
Backend tests:        bun run scripts/test/run.ts --scope backend
Dashboard tests:      bun run scripts/test/run.ts --scope dashboard
```

`--scope backend` needs `CARTETHYIA_TEST_DATABASE_URL`; `bun run test-db:up` starts a disposable
Postgres on `127.0.0.1:55432`. The dashboard scope needs no database.

---

## Phase 1 — Foundation

### Task 1: Extract `pidAlive` to `src/shared/process.ts`

**Description:** `pidAlive` decided whether a stale lock, controller record, or tray state file is
believed, and two copies existed: `scripts/cli/instance.ts` (with the Windows `tasklist` path) and a
weaker private copy in `src/console/remote-support/service.ts`. The console route needs it, and
`src/` may not import `scripts/`, so it moves to `src/shared/` and every caller imports it from
there.

**Acceptance criteria:**
- [x] One implementation, at `src/shared/process.ts`
- [x] `scripts/cli/instance.ts`, `start.ts`, `controller.ts`, `gateway.ts`, `scripts/install/host.ts`, and `src/console/remote-support/service.ts` import it; no local copy remains
- [x] No signature or behavior change; the Windows `tasklist` branch is preserved verbatim
- [x] `pidAlive` is no longer re-exported from `instance.ts` (callers updated instead of aliased)

**Verification:**
- [x] `bun run typecheck` passes
- [x] `bun test test/console/remote-support-serve-state.test.ts test/console/remote-support-install-hint.test.ts` — 7 pass

**Dependencies:** None

**Files likely touched:**
- `src/shared/process.ts` (new)
- `scripts/cli/instance.ts`, `scripts/cli/start.ts`, `scripts/cli/controller.ts`, `scripts/cli/gateway.ts`
- `scripts/install/host.ts`
- `src/console/remote-support/service.ts`

**Estimated scope:** Small mechanically; 7 files, all one-line import swaps that cannot be split
without leaving the tree uncompilable.

---

### Task 2: Extract `isLoopbackPeer` to `src/shared/peer.ts`

**Description:** The console's tray route needs the same loopback test the drain endpoint uses. The
console composition root does not import `src/transport/`, so the predicate moves to `src/shared/`
and `drain-endpoint.ts` imports it from there.

**Acceptance criteria:**
- [x] One implementation, at `src/shared/peer.ts`, accepting `::1`, `127.0.0.0/8`, and the `::ffff:` mapped spelling
- [x] `src/transport/drain-endpoint.ts` imports it; no duplicate definition
- [x] The deferred-weaker-predicate note in `src/network/util/ip.ts` now points at the new location

**Verification:**
- [x] `bun run typecheck` passes
- [x] `bun test test/transport/drain-reserve-routing.test.ts` — 15 pass

**Dependencies:** None (parallel with Task 1)

**Files likely touched:**
- `src/shared/peer.ts` (new)
- `src/transport/drain-endpoint.ts`
- `src/network/util/ip.ts` (comment only)

**Estimated scope:** Small

---

## Checkpoint A: Foundation

- [x] `bun run typecheck` passes
- [x] Drain/pool and remote-support suites still pass

---

## Phase 2 — The channel has one owner

### Task 3: Move the control channel and unify the confirmation wait

**Description:** `scripts/cli/tray/control.ts` becomes `src/console/tray/control.ts` with unchanged
behavior, so the console route and the CLI read and write the same two files through one module. The
wait-for-nonce loop moves with it as `awaitTrayChange`, and the CLI's `requestTrayVisibility`
delegates instead of keeping its own copy — otherwise the CLI and the console could disagree about
what "confirmed" means. New error types let the route map failures onto console codes instead of
turning them into 500s.

**Acceptance criteria:**
- [x] The request/state file shapes, mode `0600`, atomic temp+rename write, and the "corrupt file is discarded" rule are unchanged
- [x] `awaitTrayChange` is the only wait loop; `scripts/cli/tray/commands.ts` calls it
- [x] `TrayControlUnavailableError` and `TrayChangeTimeoutError` distinguish the two failures the console route reports
- [x] The old path is gone; no compatibility alias left behind
- [x] The direct `CARTETHYIA_CONFIG_DIR` read is declared in the env-read allowlist with its reason

**Verification:**
- [x] `bun run scripts/test/run.ts --scope scripts` — 92 pass / 1 skip / 0 fail
- [x] `test/cli/tray-visibility.test.ts` passes with its import path updated and no assertion changed
- [x] `bun test test/config/no-direct-env-reads.test.ts` — 2 pass

**Dependencies:** Tasks 1, 2

**Files likely touched:**
- `src/console/tray/control.ts` (new; `scripts/cli/tray/control.ts` deleted)
- `scripts/cli/tray.ts`, `scripts/cli/tray/commands.ts`
- `test/cli/tray-visibility.test.ts`, `test/config/no-direct-env-reads.test.ts`

**Estimated scope:** Medium

---

## Checkpoint B: The CLI is unchanged

- [x] `--scope scripts` green
- [x] `carte tray hide|show|toggle|status` output and exit codes match V1

---

## Phase 3 — Slice 1: the console can see the icon's state

### Task 4: `GET /tray/status`, contracts, mount, peer resolver

**Description:** The first endpoint of the domain: report whether a tray is running and whether its
icon is on screen. Wire types live in an Elysia-free module so the dashboard can project them. The
domain is mounted like every other console domain, and the router passes the peer resolver the
composition root already computes.

**Acceptance criteria:**
- [x] `GET /console/api/tray/status` → `{ running, hidden, pid }`
- [x] No state file → `{ running: false, hidden: false, pid: null }`
- [x] A record whose pid is dead reads as "no tray running" and is deleted
- [x] A corrupt state file reads as "no tray running"
- [x] Unauthenticated → 401; a session without `platform:admin` → 403 `insufficient_scope`
- [x] `ConsoleDomainContext` gains an optional `resolvePeerAddress`; reduced compositions omit it
- [x] Unset `CARTETHYIA_CONFIG_DIR` → 409 `tray_control_unavailable`, never 500

**Verification:**
- [x] `bun test test/console/tray-routes.test.ts` — status cases pass
- [x] Real gateway probe: `/console/api/tray/status` answers 401 unauthenticated while an unknown console path answers 404, proving the mount; an admin session gets 200

**Dependencies:** Task 3

**Files likely touched:**
- `src/console/tray/contracts.ts`, `src/console/tray/routes.ts` (both new)
- `src/console/domain-registration.ts`, `src/console/console-router.ts`

**Estimated scope:** Medium

---

### Task 5: Dashboard status read

**Description:** The panel's read path: types re-exported from the backend contract, one query key,
one hook on the status cadence, and the card body with its three states. Polling rather than a push
channel because the tray writes a file that only a read observes, and the tray's own menu can change
its state without the dashboard doing anything.

**Acceptance criteria:**
- [x] Types and the action tuple are re-exported from `src/console/tray/contracts.ts`; no second copy
- [x] `queryKeys.tray.status` exists; no inline key in the feature
- [x] Running + visible → Hide enabled, Show disabled; running + hidden → the reverse
- [x] No tray → both disabled, and the panel names `carte tray` as how to start one
- [x] A failed read shows the server's sentence and a retry

**Verification:**
- [x] `bun run dashboard:typecheck` passes
- [x] `bun test dashboard/test/features/tray-panel.test.tsx` — state cases pass

**Dependencies:** Task 4

**Files likely touched:**
- `dashboard/src/data/contracts.ts`, `dashboard/src/data/query-keys.ts`
- `dashboard/src/hooks/tray.ts` (new)
- `dashboard/src/features/settings/TrayPanel.tsx` (new)

**Estimated scope:** Medium

---

## Checkpoint C: Status is visible

- [x] Settings → Tray renders the correct state for each case
- [x] Route cleanup of dead-pid records verified

---

## Phase 4 — Slice 2: hide and restore the icon

### Task 6: `POST /tray/visibility` with nonce confirmation

**Description:** The mutating half. It writes a request and answers only once the tray has confirmed
it by quoting the request's nonce, so a resolved response means the icon really moved. It refuses
when no tray runs, and it answers an already-satisfied request from the record instead of waking the
tray to do nothing.

**Acceptance criteria:**
- [x] `{ action: "hide" | "show" }` → the confirmed `{ running, hidden, pid }`
- [x] The response waits for a state record whose nonce matches this request; a stale record with no nonce does not count
- [x] Timeout → 504 `tray_visibility_timeout`, and the pending request is removed so the tray cannot act on it later
- [x] No tray → 409 `tray_not_running` and nothing written
- [x] Asking for the current state → 200 from the record, no request file
- [x] An unknown action → 422 from the body schema, before the channel is touched

**Verification:**
- [x] `bun test test/console/tray-routes.test.ts` — 15 pass
- [x] Real gateway probe against an isolated instance: `hide` → `{hidden:true}` after a simulated tray ack, `show` → `{hidden:false}`, repeat `show` → no request file left

**Dependencies:** Task 4

**Files likely touched:**
- `src/console/tray/routes.ts`
- `test/console/tray-routes.test.ts` (new)

**Estimated scope:** Medium

---

### Task 7: Panel actions, disabled states, and toasts

**Description:** The buttons in the card. Each reports both outcomes, per the dashboard's contract:
a confirmed change toasts the outcome, a failure toasts the server's own sentence rather than a
generic one. Only the live action is enabled, so the disabled one reads as "real, currently
pointless" instead of vanishing.

**Acceptance criteria:**
- [x] Clicking the live button posts exactly that action; the disabled one cannot be clicked
- [x] Success → `toast.success("Icon hidden" / "Icon shown")`
- [x] Failure → `toast.error(getErrorMessage(error, ...))`
- [x] The status query is invalidated on success rather than patched locally
- [x] The Tray section is registered in `SECTIONS`, `PANEL_BODY`, and `SectionIcon`

**Verification:**
- [x] `bun test dashboard/test/features/tray-panel.test.tsx` — action and toast cases pass
- [x] `bun run scripts/test/run.ts --scope dashboard` — 716 pass / 0 fail, including the updated `settings-sections` counts

**Dependencies:** Task 6

**Files likely touched:**
- `dashboard/src/features/settings/TrayPanel.tsx`, `dashboard/src/features/settings/SettingsPage.tsx`
- `dashboard/test/features/tray-panel.test.tsx` (new), `dashboard/test/features/settings-sections.test.tsx`

**Estimated scope:** Medium

---

## Checkpoint D: Hide and show work

- [x] Route and panel suites green
- [x] Real-gateway probe confirms both directions and the idempotent repeat

---

## Phase 5 — Slice 3: a remote browser is refused with a reason

### Task 8: Loopback gate and local-only banner

**Description:** The refusal path. A browser that is not on the gateway's machine has no tray to
talk to, so the mutation is refused with its own code and the panel explains why instead of leaving a
failed click with no reason.

**Acceptance criteria:**
- [x] Non-loopback peer → 403 `tray_control_local_only`, and no request file is written
- [x] An unknown peer (reduced composition) fails closed
- [x] The gate runs after the admin guard, so a non-admin never learns the peer policy
- [x] The panel renders an inline banner naming the restriction
- [x] The status read stays reachable from anywhere, so the panel still explains itself remotely

**Verification:**
- [x] `bun test test/console/tray-routes.test.ts` — non-loopback and unknown-peer cases pass
- [x] `bun test dashboard/test/features/tray-panel.test.tsx` — banner case passes

**Dependencies:** Task 7

**Files likely touched:**
- `src/console/tray/routes.ts`
- `dashboard/src/features/settings/TrayPanel.tsx`
- `test/console/tray-routes.test.ts`

**Estimated scope:** Small

---

## Checkpoint E: Refusal path

- [x] Refusal verified without writing a request
- [x] Banner verified on screen

---

## Phase 6 — Close-out

### Task 9a: Documentation

**Description:** Fold the delivered behavior into the pages that describe it: the spec gains the
console surface and the files it added, the delta spec flips to `implemented`, and the README's tray
paragraph names the console section.

**Acceptance criteria:**
- [x] `SPEC.md` records the console endpoints, their gates, and their error codes
- [x] `SPEC-console-tray-control.md` reads `Status: implemented`
- [x] `README.md` mentions Settings → Tray and its loopback restriction

**Verification:**
- [x] No file references the removed `scripts/cli/tray/control.ts` path

**Dependencies:** Tasks 3–8

**Files likely touched:**
- `SPEC.md`, `SPEC-console-tray-control.md`, `README.md`

**Estimated scope:** Small

---

### Task 9b: Manual macOS end-to-end

**Description:** The real thing: a running tray, the dashboard open on the same machine, and the four
observations the spec's success criteria name. **Blocked on operator consent** — running it means
stopping the tray and gateway currently running on this machine.

**Acceptance criteria:**
- [x] Settings → Tray reports the running tray and `icon visible`
- [x] `Hide icon` → the icon leaves the menu bar within 2 s, `GET /health` still answers 200, `carte tray status` prints `icon hidden`
- [x] `Show icon` → the icon returns within 2 s, `carte tray status` prints `icon visible`
- [ ] The tray menu still works after both directions (`Open Console` opens the dashboard) — **not clicked**: a real menu bar click cannot be driven from here. The row→id resolution after a hide/show cycle is covered by `test/cli/tray-visibility.test.ts` ("show starts a new helper and the same rows still resolve to their ids").

**Verification:**
- [x] Manual, on this machine, with the operator's agreement
- [x] If declined: reported as unverified in the final report, not claimed as passing

**How it was run:** an isolated install (`mkdtemp` config + data dir, port 17999, Lite mode), so no
operator data was touched, with `CARTETHYIA_GATEWAY_BINARY=src/main.ts` so the tray started the
gateway from current source rather than the stale `dist/cartethyia`. The dashboard bundle was rebuilt
(`bun run dashboard:build`) so the served UI contained the new card. The panel was driven in a real
browser (Lightpanda): sign-in → Settings → the Tray card → `Hide icon` → `Show icon`.

| Observation | Result |
|---|---|
| Panel state while visible | "The tray is running, with its icon visible", Hide enabled |
| `Hide icon` from the browser | 200 in 0.92 s; helper process (`tray_darwin_release`, the icon itself) gone after 0.99 s; toast "Icon hidden"; state carried the request nonce |
| Gateway while hidden | `GET /health` → 200; tray process still alive |
| `carte tray status` while hidden | `Cartethyia tray is running (PID 44848); icon hidden.` |
| `Show icon` from the browser | 200 in 1.02 s; new helper in 1.07 s; toast "Icon shown"; state visible |
| `carte tray status` while visible | `...; icon visible.` |
| Repeat `show` (idempotent) | 200 from the record, no `tray-request.json` written |

Not covered: clicking the tray menu itself, and `Exit` from the tray menu leaving no state files
(criteria 5d and 7) — both need a real menu bar interaction.

**Incidental findings (reported, not fixed — outside this change):**
- `carte --tray` fails from a source checkout with `Unknown command: --tray`; the working form is
  `carte tray`. The shim forwards argv verbatim and `main.ts` only accepts `tray`.
- A tray from an earlier session was still running (PID 79551, icon hidden) with its gateway on port
  12800. Left untouched.

**Dependencies:** Tasks 7, 8

**Files likely touched:** none

**Estimated scope:** Small, but requires stopping a live process

---

## Checkpoint F: Complete

- [x] Every acceptance criterion met, or explicitly reported as unverified
- [x] `bun run typecheck`, `bun run dashboard:typecheck`, and all three scopes green
- [x] Windows/Linux tray behavior stated as implemented and unit-tested only
- [x] Manual macOS criteria demonstrated or reported as unverified — 5a–5c demonstrated in a real
      browser against a real tray; 5d (menu click) and criterion 7 (Exit cleanup) reported as not
      clicked
- [x] Nothing pushed or deployed; the seven slices are local commits on `feat/tray-hide-icon`
