# Implementation Plan: Console Tray Icon Control

Source spec: `SPEC-console-tray-control.md` (delta; folded into `SPEC.md`)
Base: `SPEC.md` — Tray Icon Hide/Show V1, `Status: implemented`
Branch: `feat/tray-hide-icon`

## Overview

V1 shipped the tray control channel (`tray-request.json` / `tray-state.json`), the tray menu row, and
`carte tray hide|show|toggle|status`. This delta gives the console the same control: two console
endpoints guarded by `platform:admin` and a loopback peer, plus a Settings → Tray card that reports
the icon state and hides or restores it.

The work in this plan is **already implemented and verified**; the plan is the reviewable record of
how it was sliced, plus the one genuinely open item — the manual macOS end-to-end check, which needs
the operator's consent to stop the local tray and gateway.

## Architecture Decisions

1. **One owner for the channel.** `scripts/cli/tray/control.ts` moved to
   `src/console/tray/control.ts`. `src/` must not import `scripts/`, and the console route needs the
   exact same file protocol the CLI and the tray already share. Behavior is unchanged; only import
   paths moved.
2. **`src/` cannot reach into the transport layer either.** `pidAlive` and `isLoopbackPeer` moved to
   `src/shared/`, so the console composition root keeps its stated boundary (it declares
   collaborators structurally, it does not import their owners). Both moves are behavior-preserving,
   and each collapsed an existing duplicate.
3. **Two gates, not one.** `platform:admin` because tray visibility is host state, not tenant data —
   the same guard the IP-ban and audit domains use. A loopback peer because a browser on another
   machine has no tray to talk to: its request would hide an icon the operator over there can neither
   see nor restore.
4. **Confirmation is the nonce, never a timestamp.** The route reuses `writeTrayRequest` and waits for
   a state record quoting that nonce, exactly as the CLI does. A tray acting inside the same
   millisecond as the request would otherwise look identical to the state that was already there.
5. **Idempotent no-op.** Asking for the state the tray is already in is answered from the record
   without writing a request — waking the tray to do nothing would report a failure the operator
   cannot act on.

## Dependency graph

```
src/shared/process.ts (pidAlive)      src/shared/peer.ts (isLoopbackPeer)
              └───────────────┬───────────────┘
                              ▼
              src/console/tray/control.ts   ← single owner of the channel
               │            │  (import path only)
               │            └──────────────► scripts/cli/tray.ts, scripts/cli/tray/commands.ts
               ▼
              src/console/tray/contracts.ts (pure wire types)
               ▼
              src/console/tray/routes.ts  ──needs──► src/shared/peer.ts
               ▼
              domain-registration.ts + console-router.ts (mount + peer resolver)
               ▼
         ★ /console/api/tray/*    observable boundary (curl)
               ▼
         dashboard: data/contracts → data/query-keys → hooks/tray.ts
               ▼
         features/settings/TrayPanel.tsx → SettingsPage.tsx
               ▼
         ★ Settings → Tray        observable boundary (browser)
```

Dependencies point one way, with no cycles. Build order is the graph bottom-up.

## Task List

### Phase 1: Foundation (pure moves)

- [x] Task 1: Extract `pidAlive` to `src/shared/process.ts`
- [x] Task 2: Extract `isLoopbackPeer` to `src/shared/peer.ts`

### Checkpoint A: Foundation
- [x] `bun run typecheck` passes — no stale import anywhere
- [x] `test/config/no-direct-env-reads.test.ts` and the drain/pool suites still pass

### Phase 2: The channel has one owner

- [x] Task 3: Move the control channel, add `awaitTrayChange`, re-point the CLI

### Checkpoint B: The CLI is unchanged
- [x] `bun run scripts/test/run.ts --scope scripts` passes (92 pass / 1 skip / 0 fail)
- [x] `carte tray hide|show|toggle|status` behave exactly as in V1

### Phase 3: Slice 1 — the console can see the icon's state

- [x] Task 4: `GET /tray/status`, contracts, mount, peer resolver
- [x] Task 5: Dashboard status read (contracts, query key, hook, panel states)

### Checkpoint C: Status is visible
- [x] Settings → Tray renders the three states correctly
- [x] Route answers 401 unauthenticated, 403 non-admin, and cleans up a dead-pid record

### Phase 4: Slice 2 — the operator can hide and restore the icon

- [x] Task 6: `POST /tray/visibility` with nonce confirmation
- [x] Task 7: Hide/Show buttons, disabled states, and toasts

### Checkpoint D: Hide and show work
- [x] Route suite: hide/show confirmed by nonce, timeout → 504 + request removed, no tray → 409
- [x] Panel suite: only the live action is sent; success toasts; failure reports the server sentence
- [x] Real gateway probe: hide → `{hidden:true}` after a simulated tray ack, show → back, repeat show → no request file

### Phase 5: Slice 3 — a remote browser is refused with a reason

- [x] Task 8: Loopback gate and the local-only banner

### Checkpoint E: Refusal path
- [x] Non-loopback peer → 403 `tray_control_local_only`, no request written
- [x] Unknown peer fails closed

### Phase 6: Close-out

- [x] Task 9a: Documentation folded in (`SPEC.md`, `SPEC-console-tray-control.md`, `README.md`)
- [x] Task 9b: Manual macOS end-to-end pass — 5a–5c demonstrated against a real tray in a real
      browser; 5d and Exit cleanup reported as not clicked (need a menu bar interaction)
- [x] Task 9c: Commit the work as per-task slices

### Checkpoint F: Complete
- [x] Both typechecks and all three test scopes green
- [x] Windows/Linux tray paths stated as implemented-but-unverified
- [x] Manual macOS criteria 5a–5d demonstrated or reported as unverified
- [x] Nothing pushed or deployed; the slices are local commits on `feat/tray-hide-icon`

## Verification results

| Check | Result |
|---|---|
| `bun run typecheck` | pass |
| `bun run dashboard:typecheck` | pass |
| `--scope scripts` | 92 pass, 1 skip, 0 fail |
| `--scope backend` (disposable Postgres via Docker) | 5188 pass, 33 skip (Redis-gated), 0 fail |
| `--scope dashboard` | 716 pass, 0 fail |
| `test/console/tray-routes.test.ts` | 15 pass |
| `dashboard/test/features/tray-panel.test.tsx` | 6 pass |
| Real gateway probe (isolated Lite instance) | 401 unauth vs 404 unknown path; admin 200; hide/show confirmed; dead pid → 409 `tray_not_running` with cleanup |
| Manual macOS, real tray + real browser (Lightpanda) | Hide → icon gone in 0.99 s, `/health` 200; Show → icon back in 1.07 s; menu click not exercised |

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Shared `pidAlive` changes Windows behavior in remote-support | Med | Shared version is strictly more accurate (tasklist instead of `process.kill(pid, 0)`); recorded in the report |
| Route blocks a request thread for up to 3 s | Low | Same budget the CLI uses; the tray polls at 1 s, so this is two polls of slack |
| `CARTETHYIA_CONFIG_DIR` unset in the gateway process | Med | Named 409 `tray_control_unavailable`, never a 500 |
| Dashboard polls forever | Low | Polls on the status cadence; one card on a settings page |
| Manual macOS pass needs the local tray stopped | Med | Asked for before it happens; reported as unverified if declined |

## Open Questions

1. **Manual macOS verification.** May the local tray and its gateway be restarted for criteria 5a–5d
   (icon leaves the menu bar, `/health` still 200, icon returns, tray menu still works)? Until then
   the item stays open and is reported as unverified.
2. **V1 records.** `tasks/archive/plan-v1-tray-hide-show.md` and
   `tasks/archive/todo-v1-tray-hide-show.md` keep the V1 plan, including its one permanently
   unverifiable manual line, so the history is not lost.
