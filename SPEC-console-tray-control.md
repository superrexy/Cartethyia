# Spec Delta: Console Tray Icon Control

Status: implemented
Extends: `SPEC.md` (Tray Icon Hide/Show — V1, `Status: implemented`)
Repository: `superrexy/Cartethyia`, branch `feat/tray-hide-icon`

## Objective

Give the console dashboard the same tray visibility control the CLI already has: a Settings
section that reports whether the tray is running and hides or restores its icon.

V1 shipped the control channel and the CLI (`carte tray hide|show|toggle|status`). The dashboard
was explicitly out of scope. That leaves the browser operator — who is already in the console —
without the control, and hiding from the dashboard is what makes the feature complete: the panel
that hides the icon is also the panel that brings it back.

User: the operator running Cartethyia on their own machine, signed into the console as a
platform admin, opening the page from that same machine.

Success: from Settings, `Hide icon` removes the menu bar / notification-area icon within ~2 s
while `/health` keeps answering, `Show icon` restores it, and the CLI behaves exactly as before.

## Current Behavior

From `SPEC.md` (V1), all implemented:

- `scripts/cli/tray/control.ts` owns the file channel: `tray-request.json` (written by a command,
  consumed once by the tray) and `tray-state.json` (written by the tray, read by `status`).
- `scripts/cli/tray.ts` polls the request file every 1 000 ms and rewrites the state file.
- `scripts/cli/tray/commands.ts` implements the CLI wait-for-nonce confirmation.
- The tray menu has a `Hide icon` row; the gateway lifecycle is untouched by any of it.

The console has no tray surface at all:

- `src/console/` has no `/tray` route and no module that touches the control files.
- `dashboard/src/` has no tray component, hook, contract, or query key. (The two `tray` grep hits
  in `dashboard/src` are the word inside unrelated dialog copy.)

So today the dashboard cannot see or change tray visibility, and nothing tells it whether a tray
is running.

## New Behavior

### 1. One owner for the control channel

`scripts/cli/tray/control.ts` moves to `src/console/tray/control.ts`, unchanged in behavior. The
console route needs the exact same channel, and `src/` must not import from `scripts/`; the
precedent for the reverse direction already exists (`scripts/cli/update.ts` imports
`src/console/updates/apply-update`). Importers to update, no aliases left behind:

```
scripts/cli/tray.ts               import path only
scripts/cli/tray/commands.ts      import path only
test/cli/tray-visibility.test.ts  import path only
```

Two pure helpers the channel needs move with it, so `src/` does not reach into `scripts/` or the
transport layer:

- `pidAlive` — `scripts/cli/instance.ts` owns it and `src/console/remote-support/service.ts`
  keeps a private copy. Extract to `src/shared/process.ts`; update `scripts/cli/instance.ts`,
  `scripts/cli/start.ts`, `scripts/cli/controller.ts`, `scripts/cli/gateway.ts`,
  `scripts/install/host.ts`, and `src/console/remote-support/service.ts` to import it. Pure move:
  no signature or behavior change.
- `isLoopbackPeer` — currently exported by `src/transport/drain-endpoint.ts`. Move to
  `src/shared/peer.ts` and import it from `drain-endpoint.ts` and the new tray routes. The console
  composition root's stated boundary is that it does not import the transport layer.

### 2. Console API domain `src/console/tray/`

`GET /tray/status` and `POST /tray/visibility`, both guarded by `requireGlobalAdmin` — tray
visibility is host state, not tenant data, like the IP-ban and audit domains.

```
GET  /console/api/tray/status
→ 200 { "running": true, "hidden": false, "pid": 4242 }
→ 200 { "running": false, "hidden": false, "pid": null }     no live tray

POST /console/api/tray/visibility   { "action": "hide" | "show" }
→ 200 { "running": true, "hidden": true, "pid": 4242 }        change confirmed by nonce
→ 403 tray_control_local_only    peer is not loopback (also when the peer is unknown)
→ 403 insufficient_scope         caller lacks platform:admin
→ 409 tray_not_running           no live tray state file
→ 409 tray_control_unavailable   CARTETHYIA_CONFIG_DIR is unset in the gateway process
→ 504 tray_visibility_timeout    the tray did not confirm within 3 s
```

Rules:

- `status` reads through `readTrayState()`, so a dead pid reads as "no tray running" and the
  stale file is removed — the panel can never show an icon that is not there.
- `visibility` reuses `writeTrayRequest()` and waits for a state record whose `nonce` matches the
  request it just wrote. The tray polls at 1 s, so 3 s tolerates two missed polls; it never
  assumes the change happened.
- The loopback gate uses the raw peer the router already resolves (`resolvePeerAddress`, fed from
  `server.requestIP` in `src/boot/app.ts`), checked with `isLoopbackPeer`. Unknown peer fails
  closed. `CARTETHYIA_CONFIG_DIR` being unset is a 409 with a readable sentence, not a 500.
- `ConsoleDomainContext` gains an optional `resolvePeerAddress`; `console-router.ts` passes the
  value it already receives. Registration goes through `domain-registration.ts` like every other
  domain.

### 3. Dashboard

- `dashboard/src/features/settings/TrayPanel.tsx` — one card body, three states:
  - no tray running: status line plus "No tray is running on this machine; start one with
    `carte tray`" and both buttons disabled;
  - running, visible: `Hide icon` enabled, `Show icon` disabled;
  - running, hidden: `Show icon` enabled, `Hide icon` disabled.
  It states that a hidden icon comes back from this panel or `carte tray show`, because that is
  the only reason hiding is safe. Success uses `toast.success("Icon hidden")` /
  `toast.success("Icon shown")`; failures use `toast.error(getErrorMessage(error, ...))`. A
  `tray_control_local_only` response also renders an inline banner: this control only works from
  the machine running the gateway.
- `dashboard/src/hooks/tray.ts` — `useTrayStatus` and `useSetTrayVisibility` (mutation invalidates
  the status key). Status is polled on a slow interval; there is no push channel.
- `dashboard/src/data/contracts.ts` — `TrayStatusResponse`, `TrayVisibilityAction`.
- `dashboard/src/data/query-keys.ts` — `tray.status`.
- `dashboard/src/features/settings/SettingsPage.tsx` — new `SECTIONS` entry
  `{ id: "tray", title: "Tray", description: "Menu bar icon visibility on this machine" }` in the
  System group, an icon in `SectionIcon`, `PANEL_BODY.tray = <TrayPanel />`. No new route and no
  navigation change.

### 4. Unchanged by design

- `tray-request.json` / `tray-state.json` wire shapes, the 1 s poll, the 0600 mode, the nonce
  confirmation, and the tray menu.
- Every CLI command's output, exit codes, and timing.
- The gateway lifecycle: no route may stop, drain, restart, or re-adopt the gateway, and the
  controller lease is never touched.

## Files

```
src/console/tray/control.ts        MOVED  from scripts/cli/tray/control.ts, behavior unchanged
src/console/tray/contracts.ts      NEW    response/body shapes, error mapping
src/console/tray/routes.ts         NEW    status + visibility, admin guard, loopback gate
src/shared/process.ts              NEW    pidAlive (moved out of scripts/cli/instance.ts)
src/shared/peer.ts                 NEW    isLoopbackPeer (moved out of transport/drain-endpoint.ts)
src/console/domain-registration.ts EDIT   register the tray domain, add resolvePeerAddress to ctx
src/console/console-router.ts      EDIT   pass resolvePeerAddress into the domain context
src/transport/drain-endpoint.ts    EDIT   import isLoopbackPeer from src/shared/peer.ts
src/console/remote-support/service.ts EDIT use shared pidAlive
scripts/cli/instance.ts            EDIT   use shared pidAlive, drop the local copy
scripts/cli/{start,controller,gateway}.ts, scripts/install/host.ts
                                   EDIT   import pidAlive from src/shared/process.ts
scripts/cli/tray.ts, scripts/cli/tray/commands.ts
                                   EDIT   import the channel from src/console/tray/control.ts
dashboard/src/features/settings/TrayPanel.tsx  NEW
dashboard/src/hooks/tray.ts                    NEW
dashboard/src/features/settings/SettingsPage.tsx EDIT  section entry + panel body
dashboard/src/data/contracts.ts                EDIT  response types
dashboard/src/data/query-keys.ts               EDIT  tray key
test/console/tray-routes.test.ts               NEW   route behavior
dashboard/test/features/tray-panel.test.tsx    NEW   panel states
test/cli/tray-visibility.test.ts               EDIT  import path only
SPEC.md                                        EDIT  fold the outcome in after this ships
SPEC-console-tray-control.md                   this delta
```

## Commands

```
Typecheck:            bun run typecheck
Dashboard typecheck:  bun run dashboard:typecheck
CLI tests:            bun run scripts/test/run.ts --scope scripts
Backend route tests:  bun run scripts/test/run.ts --scope backend test/console/tray-routes.test.ts
Dashboard tests:      bun run dashboard:test
```

Backend suites need `CARTETHYIA_TEST_DATABASE_URL`; if no disposable database is available the
limitation is reported instead of claimed as passing. Dashboard tests do not need it.

## Code Style

Match the repository: explicit return types, `readonly` fields, `#private` members, comments that
state why, no `any`, no suppressions, English only.

```ts
// src/console/tray/routes.ts
.post("/visibility", { body: trayVisibilityBody }, async ({ request, body, set }) => {
  try {
    // Host state, not tenant data: the same guard the other instance-level
    // operations use, so a tenant key cannot hide the operator's icon.
    requireGlobalAdmin(config.accessResolver(request));
    // A remote browser has no tray to talk to; failing closed keeps a
    // misrouted request from hiding an icon nobody there can see.
    if (!isLoopbackPeer(config.resolvePeerAddress?.(request) ?? null)) {
      throw new ConsoleDomainError(
        "tray_control_local_only",
        403,
        "Tray control is only available from the machine running the gateway",
      );
    }
    return await setVisibility(body.action);
  } catch (e) {
    return errorResponse(e, set);
  }
})
```

## Testing Strategy

- Framework: `bun:test` through `scripts/test/run.ts` for backend/CLI, and the dashboard scope for
  `dashboard/`. Never bare `bun test` at the repository root.
- `test/console/tray-routes.test.ts` — temp `CARTETHYIA_CONFIG_DIR` per test (`mkdtempSync`, as
  `test/cli/controller.test.ts` does): status with no file, with a live-pid state, with a dead-pid
  state; hide writes a request whose nonce a simulated tray echoes back; timeout when no echo;
  non-loopback peer → 403 and no request file written; non-admin → 403; unset config dir → 409.
- `test/cli/tray-visibility.test.ts` — unchanged assertions, import path only, must stay green.
- `dashboard/test/features/tray-panel.test.tsx` — the three states, the local-only banner, and the
  success/error toasts with mocked hooks, following `settings-sections.test.tsx`.
- Manual, macOS, this machine — the end-to-end path under Success Criteria.
- Windows and Linux tray behavior stays unverified here, exactly as V1 states.

## Boundaries

Only deltas; everything else inherits from `SPEC.md`.

- **Always**
  - Guard both tray routes with `platform:admin` and gate mutations on a loopback peer.
  - Keep hide/show out of the gateway lifecycle and the controller lease.
  - Keep the dashboard browser-safe: it calls `/console/api`, never the filesystem.
  - Keep the control file shapes and mode `0600` exactly as V1 defined them.
  - Run `bun run typecheck` and `bun run dashboard:typecheck` before reporting.
- **Ask first**
  - Changing the tray request/state wire format, or the CLI's output and exit codes.
  - Moving a helper outside the file list above.
  - Adding a dependency (target: none).
  - Touching a real running tray/gateway on this machine for the manual test.
  - Pushing the branch or opening a PR.
- **Never**
  - Let a tenant-scoped credential hide or show the host's icon.
  - Treat an unknown peer as loopback.
  - Report a visibility change the state file did not confirm.
  - Change `scripts/` behavior while relocating the channel.
  - Commit secrets, weaken types, or remove a failing test.

## Success Criteria

1. `bun run typecheck` and `bun run dashboard:typecheck` pass.
2. `bun run scripts/test/run.ts --scope scripts` passes; the CLI suite is unchanged apart from the
   import path.
3. `test/console/tray-routes.test.ts` passes (or the missing test database is reported).
4. `bun run dashboard:test` passes, including the new panel test.
5. Manual, macOS, dashboard open from the same machine:
   a. Settings → Tray reports the running tray and `icon visible`;
   b. `Hide icon` → icon leaves the menu bar within 2 s, `GET /health` still answers 200,
      `carte tray status` prints `icon hidden`;
   c. `Show icon` → icon returns within 2 s and `carte tray status` prints `icon visible`;
   d. the tray menu still works after both directions (`Open Console` opens the dashboard).
6. No tray running (`carte start` without a tray) → the panel says so, both buttons disabled, and
   `POST /tray/visibility` would return 409 `tray_not_running` rather than writing a request.
7. A request from a non-loopback address → 403 `tray_control_local_only`, no
   `tray-request.json` written, and the icon unchanged.
8. A signed-in non-admin (tenant key or non-admin session) → 403 `insufficient_scope` on both
   routes.
9. `carte tray hide|show|toggle|status`, the tray menu, `carte start|stop|menu`, and `Exit` behave
   exactly as before; no `tray-state.json`/`tray-request.json` left behind after `Exit`.

## Out of Scope (Deferred)

- Tray controls outside Settings (topbar action, dedicated `/tray` route).
- Live push of tray state to the dashboard — status is polled.
- Scheduled hide (`hide for 30m`), starting hidden, or persisting hidden across restarts (all
  already deferred in V1).
- Controlling a tray on another host (remote agent, SSH), and per-user visibility for multi-user
  installs.
- macOS template-icon/dark-mode variants.

## Open Questions

None blocking. Assumptions recorded for the reviewer:

1. The dashboard is opened from the same machine as the gateway in the supported case; a remote
   browser gets the local-only message by design.
2. "Tray icon" means the same status item V1 hides — the tray process keeps running so the panel
   and the CLI can both restore it.
3. `CARTETHYIA_CONFIG_DIR` is inherited by the gateway when the tray starts it
   (`scripts/cli/gateway.ts` passes `process.env`), which is what lets the route reach the same
   files the tray polls. A gateway started without it reports `tray_control_unavailable`.
4. Extracting `pidAlive` and `isLoopbackPeer` is part of this change because `src/` cannot import
   `scripts/` or the transport layer; both moves are behavior-preserving.
