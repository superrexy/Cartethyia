/**
 * The tray control channel: the two files that let a CLI command ask a running
 * tray to change its icon and read back what it did.
 *
 * Everything here is filesystem state, so the tests point
 * `CARTETHYIA_CONFIG_DIR` at a temp directory and never touch the operator's
 * real config — the same isolation `test/cli/controller.test.ts` uses.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClickEvent, MenuItem } from "systray2";
import {
  clearTrayRequest,
  clearTrayState,
  consumeTrayRequest,
  readTrayState,
  writeTrayRequest,
  writeTrayState,
} from "../../scripts/cli/tray/control";
import {
  createTray,
  type Tray,
  type TrayHelper,
  type TrayItem,
  type UnixHelperFactory,
  type UnixHelperOptions,
} from "../../scripts/cli/tray/index";

let configDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "carte-tray-control-test-"));
  originalConfigDir = process.env.CARTETHYIA_CONFIG_DIR;
  process.env.CARTETHYIA_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CARTETHYIA_CONFIG_DIR;
  else process.env.CARTETHYIA_CONFIG_DIR = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

const requestPath = (): string => join(configDir, "tray-request.json");
const statePath = (): string => join(configDir, "tray-state.json");

/** A pid that is certainly gone: a child that has already exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

test("a request is written with the documented shape and owner-only permissions", () => {
  writeTrayRequest("hide");

  const written = JSON.parse(readFileSync(requestPath(), "utf8")) as Record<string, unknown>;
  expect(written.request).toBe("hide");
  expect(typeof written.nonce).toBe("string");
  expect((written.nonce as string).length).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(String(written.requestedAt)))).toBe(false);
  expect(statSync(requestPath()).mode & 0o777).toBe(0o600);
});

test("a request is consumed exactly once and then gone", () => {
  writeTrayRequest("show");

  expect(consumeTrayRequest()?.request).toBe("show");
  expect(existsSync(requestPath())).toBe(false);
  expect(consumeTrayRequest()).toBeNull();
});

test("a newer request replaces an older one rather than queueing behind it", () => {
  writeTrayRequest("hide");
  writeTrayRequest("show");

  expect(consumeTrayRequest()?.request).toBe("show");
  expect(existsSync(requestPath())).toBe(false);
});

test("a corrupt request file is ignored and removed, never thrown on", () => {
  writeFileSync(requestPath(), "{ this is not json", "utf8");

  expect(consumeTrayRequest()).toBeNull();
  expect(existsSync(requestPath())).toBe(false);
});

test("an unknown request value is ignored and removed", () => {
  writeFileSync(requestPath(), JSON.stringify({ request: "explode" }), "utf8");

  expect(consumeTrayRequest()).toBeNull();
  expect(existsSync(requestPath())).toBe(false);
});

test("visibility state round-trips for the live process", () => {
  writeTrayState({ pid: process.pid, hidden: true });

  const state = readTrayState();
  expect(state?.pid).toBe(process.pid);
  expect(state?.hidden).toBe(true);
  expect(Number.isNaN(Date.parse(String(state?.updatedAt)))).toBe(false);
});

test("state left behind by a dead tray reads as no tray and is removed", async () => {
  const pid = await deadPid();
  writeTrayState({ pid, hidden: true });

  expect(readTrayState()).toBeNull();
  expect(existsSync(statePath())).toBe(false);
});

test("a corrupt state file reads as no tray instead of killing the caller", () => {
  writeFileSync(statePath(), "null", "utf8");

  expect(readTrayState()).toBeNull();
});

test("clearing is idempotent for both files", () => {
  writeTrayRequest("toggle");
  writeTrayState({ pid: process.pid, hidden: false });

  clearTrayRequest();
  clearTrayState();
  clearTrayRequest();
  clearTrayState();

  expect(existsSync(requestPath())).toBe(false);
  expect(existsSync(statePath())).toBe(false);
});

test("an unresolved config directory fails with a clear message, not a parse error", () => {
  delete process.env.CARTETHYIA_CONFIG_DIR;

  expect(() => writeTrayRequest("hide")).toThrow("config directory");
  expect(() => readTrayState()).toThrow("config directory");
});

// ---------------------------------------------------------------------------
// Tray visibility: macOS/Linux helper lifecycle
//
// The helper is faked here rather than spawned: a real `systray2` helper draws
// an icon in the menu bar of whoever runs the suite. The fake mirrors the one
// behaviour the production code depends on — `kill()` reports `exit` before it
// settles, exactly like a real helper going away.
// ---------------------------------------------------------------------------

interface FakeHelper {
  readonly helper: TrayHelper;
  readonly menu: readonly MenuItem[];
  /** Rows the tray asked the helper to update, in order. */
  readonly updates: MenuItem[];
  killCalls: number;
  /** Simulates the helper exiting on its own, e.g. a crash. */
  crash(): void;
  click(row: MenuItem): void;
}

interface UnixHarness {
  readonly factory: UnixHelperFactory;
  readonly created: FakeHelper[];
}

function unixHarness(): UnixHarness {
  const created: FakeHelper[] = [];
  const factory: UnixHelperFactory = (options: UnixHelperOptions) => {
    let exitCode: number | null = null;
    const exitListeners: (() => void)[] = [];
    const clickListeners: ((action: ClickEvent) => void)[] = [];
    const record: FakeHelper = {
      menu: options.items,
      updates: [],
      killCalls: 0,
      crash: () => {
        exitCode = 1;
        for (const listener of exitListeners) listener();
      },
      click: (row) => {
        // The helper reports the clicked row's own number, which is what a
        // click on a row rebuilt by `show()` has to match.
        const id = (row as MenuItem & { __id?: number }).__id ?? 0;
        for (const listener of clickListeners) {
          listener({ type: "clicked", item: row, seq_id: 1, __id: id });
        }
      },
      helper: {
        // Numbering mirrors the helper: rows are numbered from 1 in menu order
        // once it reports ready, which is what `update()` needs to target one.
        ready: async () => {
          record.menu.forEach((item, index) => {
            (item as MenuItem & { __id?: number }).__id = index + 1;
          });
        },
        onClick: async (listener) => {
          clickListeners.push(listener);
        },
        onExit: (listener) => {
          exitListeners.push(listener);
        },
        sendAction: async (action) => {
          if (action.type === "update-item") record.updates.push(action.item);
        },
        kill: async () => {
          record.killCalls += 1;
          exitCode = 0;
          for (const listener of exitListeners) listener();
        },
        get process() {
          return { exitCode, signalCode: null };
        },
      },
    };
    created.push(record);
    return record.helper;
  };
  return { factory, created };
}

const VISIBILITY_ROWS: readonly TrayItem[] = [
  { kind: "action", id: "console", title: "Open Console" },
  { kind: "action", id: "hide", title: "Hide icon" },
  { kind: "action", id: "exit", title: "Exit" },
];

function unixTray(harness: UnixHarness): { tray: Tray; selected: string[]; exits: () => number } {
  const selected: string[] = [];
  let exitCount = 0;
  const tray = createTray(
    {
      iconPath: "/tmp/cartethyia-test.png",
      tooltip: "Cartethyia test",
      items: VISIBILITY_ROWS,
      onSelect: (id) => selected.push(id),
      onExit: () => {
        exitCount += 1;
      },
    },
    { createUnixHelper: harness.factory },
  );
  return { tray, selected, exits: () => exitCount };
}

test("hide removes the icon without reporting a crashed helper", async () => {
  const harness = unixHarness();
  const { tray, exits } = unixTray(harness);
  await tray.ready();

  expect(tray.isVisible()).toBe(true);
  await tray.hide();

  expect(tray.isVisible()).toBe(false);
  expect(harness.created[0]?.killCalls).toBe(1);
  // The helper's exit during a hide is the hide itself, not a crash: reporting
  // it would close the gateway, which is the one thing hiding must not do.
  expect(exits()).toBe(0);
});

test("a helper that exits on its own is still reported as gone", async () => {
  const harness = unixHarness();
  const { tray, exits } = unixTray(harness);
  await tray.ready();

  harness.created[0]?.crash();

  expect(exits()).toBe(1);
});

test("show starts a new helper and the same rows still resolve to their ids", async () => {
  const harness = unixHarness();
  const { tray, selected } = unixTray(harness);
  await tray.ready();
  await tray.hide();
  await tray.show();

  expect(harness.created).toHaveLength(2);
  expect(tray.isVisible()).toBe(true);
  const hiddenRow = harness.created[1]?.menu[1];
  expect(hiddenRow?.title).toBe("Hide icon");
  harness.created[1]?.click(hiddenRow!);
  expect(selected).toEqual(["hide"]);
});

test("hiding twice kills one helper and showing twice starts one more", async () => {
  const harness = unixHarness();
  const { tray } = unixTray(harness);
  await tray.ready();

  await tray.hide();
  await tray.hide();
  expect(harness.created[0]?.killCalls).toBe(1);

  await tray.show();
  await tray.show();
  expect(harness.created).toHaveLength(2);
});

test("rows updated after a show target the new helper's numbering", async () => {
  const harness = unixHarness();
  const { tray } = unixTray(harness);
  await tray.ready();
  await tray.hide();
  await tray.show();

  tray.update("hide", "Hide icon \u00b7 again");

  expect(harness.created[1]?.updates.map((item) => item.title)).toEqual(["Hide icon \u00b7 again"]);
});

test("a click still resolves the right id after two hide/show cycles", async () => {
  const harness = unixHarness();
  const { tray, selected } = unixTray(harness);
  await tray.ready();

  await tray.hide();
  await tray.show();
  await tray.hide();
  await tray.show();

  expect(harness.created).toHaveLength(3);
  harness.created[2]?.click(harness.created[2]?.menu[2]!);
  expect(selected).toEqual(["exit"]);
});

test("closing while hidden does not kill a second time and stays invisible", async () => {
  const harness = unixHarness();
  const { tray } = unixTray(harness);
  await tray.ready();

  await tray.hide();
  await tray.close();

  expect(harness.created[0]?.killCalls).toBe(1);
  expect(tray.isVisible()).toBe(false);
});
