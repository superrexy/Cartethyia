# Task List: Console Tray Icon Control

Source spec: `SPEC-console-tray-control.md` · Plan: `tasks/plan-console-tray-control.md`

```
Typecheck:            bun run typecheck
Dashboard typecheck:  bun run dashboard:typecheck
CLI tests:            bun run scripts/test/run.ts --scope scripts
One backend file:     bun run scripts/test/run.ts --scope backend test/console/tray-routes.test.ts
Dashboard tests:      bun run dashboard:test
```

---

## Phase 1 — Shared helpers

- [x] Task: Extract `pidAlive` to `src/shared/process.ts`
  - Acceptance: one implementation; `scripts/cli/instance.ts` and `remote-support/service.ts` import it
  - Verify: `bun run typecheck`
  - Files: `src/shared/process.ts`, `src/console/remote-support/service.ts`, `scripts/cli/{instance,start,controller,gateway}.ts`, `scripts/install/host.ts`

- [x] Task: Extract `isLoopbackPeer` to `src/shared/peer.ts`
  - Acceptance: `drain-endpoint.ts` and the tray routes share one implementation
  - Verify: `bun run typecheck`
  - Files: `src/shared/peer.ts`, `src/transport/drain-endpoint.ts`

## Phase 2 — Console domain

- [x] Task: Move the control channel to `src/console/tray/control.ts`
  - Acceptance: same shapes, same messages, same 0600/atomic writes; CLI tests unchanged apart from imports
  - Verify: `bun run scripts/test/run.ts --scope scripts`
  - Files: `src/console/tray/control.ts`, `scripts/cli/tray.ts`, `scripts/cli/tray/commands.ts`, `test/cli/tray-visibility.test.ts`

- [x] Task: Add `GET /tray/status` and `POST /tray/visibility`
  - Acceptance: admin guard, loopback gate, nonce-confirmed change, 409/504 codes per spec
  - Verify: `test/console/tray-routes.test.ts`
  - Files: `src/console/tray/{contracts,routes}.ts`

- [x] Task: Register the domain and pass the peer resolver
  - Acceptance: `/console/api/tray/*` reachable; other domains unchanged
  - Verify: route test through the factory, `bun run typecheck`
  - Files: `src/console/domain-registration.ts`, `src/console/console-router.ts`

## Phase 3 — Dashboard

- [x] Task: Contracts, query key, hooks
  - Acceptance: `useTrayStatus` / `useSetTrayVisibility` typed from the backend contract
  - Verify: `bun run dashboard:typecheck`
  - Files: `dashboard/src/data/{contracts,query-keys}.ts`, `dashboard/src/hooks/tray.ts`

- [x] Task: `TrayPanel` and the Settings section
  - Acceptance: three states, local-only banner, both toasts
  - Verify: `dashboard/test/features/tray-panel.test.tsx`
  - Files: `dashboard/src/features/settings/{TrayPanel.tsx,SettingsPage.tsx}`

## Phase 4 — Verification

- [x] Task: Full scoped verification and report
  - Acceptance: typecheck, scripts scope, dashboard tests green; manual macOS result reported honestly
  - Verify: the four commands above
