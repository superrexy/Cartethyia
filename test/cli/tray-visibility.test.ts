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
import {
  clearTrayRequest,
  clearTrayState,
  consumeTrayRequest,
  readTrayState,
  writeTrayRequest,
  writeTrayState,
} from "../../scripts/cli/tray/control";

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
