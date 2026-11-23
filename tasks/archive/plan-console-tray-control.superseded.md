# Implementation Plan: Console Tray Icon Control

Source spec: `SPEC-console-tray-control.md` (delta) · Base: `SPEC.md` (V1, implemented)
Branch: `feat/tray-hide-icon`

## Overview

V1 shipped the tray control channel and the CLI. This delta gives the console the same control:
a Settings card that reports tray state and hides/restores the icon, backed by a
`platform:admin`, loopback-only console domain.

## Architecture Decisions

1. **One owner for the channel.** `scripts/cli/tray/control.ts` moves to
   `src/console/tray/control.ts`. `src/` must not import `scripts/`, and the console route needs the
   exact same file protocol the CLI and the tray already share. Behavior does not change; only the
   import paths do.
2. **`src/` cannot reach into the transport layer either.** `pidAlive` and `isLoopbackPeer` move to
   `src/shared/`, so the console composition root keeps its stated boundary. Both moves are
   behavior-preserving, and both collapse an existing duplicate (`remote-support/service.ts` has its
   own `pidAlive`).
3. **Two gates, not one.** `platform:admin` because tray visibility is host state, not tenant data;
   a loopback peer because a remote browser has no tray to talk to and a misrouted request would
   hide an icon nobody there can see. Unknown peer fails closed.
4. **Confirmation is the nonce, never a timestamp.** The route reuses `writeTrayRequest` and waits
   for a state record quoting that nonce, exactly as the CLI does. A timeout removes the request so
   the tray cannot act on it minutes later.
5. **Idempotent no-op.** A request for the state the tray is already in answers immediately from the
   state file instead of writing a request the tray would apply to no effect.

## Risks

| Risk | Mitigation |
|---|---|
| Moving `pidAlive` changes Windows behavior in remote-support | Shared version is strictly more accurate (tasklist instead of `process.kill(pid,0)`); noted in the report |
| Route blocks a request thread for up to 3 s | Same budget the CLI uses; the tray polls at 1 s, so this is two polls of slack |
| Dashboard polls forever | Slow interval, and the panel is one card on a settings page |
| Config dir unset in the gateway process | Named 409 `tray_control_unavailable`, not a 500 |

## Verification checkpoints

1. After the moves: `bun run typecheck` (proves no import path is stale).
2. After the route: `bun run scripts/test/run.ts --scope scripts test/console/tray-routes.test.ts`.
3. After the dashboard: `bun run dashboard:typecheck` and `bun run dashboard:test`.
4. Manual macOS pass per the spec's Success Criteria, only if the operator agrees to restart the
   local tray.
