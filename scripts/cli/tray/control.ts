import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../instance";

/**
 * The channel a CLI command uses to change a running tray's icon.
 *
 * Two small files in the config directory instead of a socket: the command that
 * hides or shows the icon is usually run from a terminal that is not the tray's
 * parent, and a file needs no port, no handshake, and no dependency. The tray
 * polls the request file and answers through the state file, so a command can
 * wait for the change it asked for instead of assuming it happened.
 *
 * Both files are advisory. A missing, truncated, or hand-edited file is read as
 * "nothing to do" and discarded — a tray must never die because the operator
 * edited a JSON file.
 */

/** What a command can ask the tray to do. */
export type TrayVisibilityRequest = "hide" | "show" | "toggle";

/** A pending request, consumed once by the tray. */
export interface TrayRequest {
  readonly request: TrayVisibilityRequest;
  readonly nonce: string;
  readonly requestedAt: string;
}

/** What the tray last did, so a command can confirm its request landed. */
export interface TrayState {
  readonly pid: number;
  readonly hidden: boolean;
  readonly updatedAt: string;
}

const REQUEST_FILE = "tray-request.json";
const STATE_FILE = "tray-state.json";

/**
 * The installation's config directory.
 *
 * `scripts/cli/main.ts` resolves and exports this before any subcommand runs,
 * so an unset value means the tray module was reached from somewhere that never
 * loaded the user's config — a bug worth naming rather than writing control
 * files into whatever directory the process happens to have.
 */
function configDir(): string {
  const dir = process.env.CARTETHYIA_CONFIG_DIR;
  if (!dir) {
    throw new Error("The Cartethyia config directory is unavailable; start carte before using tray commands");
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Replaces a file in one step.
 *
 * The tray polls while a command writes, so a plain write would let it read a
 * half-written document and discard a request that was actually valid. The
 * rename is atomic, so a reader sees either the previous file or the new one.
 */
function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Keep the rename error: the temp file is the least interesting failure.
    }
    throw error;
  }
}

/** Reads a JSON file, treating "missing" and "unparseable" identically. */
function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Removes a file that cannot be acted on.
 *
 * Errors are swallowed on purpose: this runs on the tray's poll loop and on
 * `status`, where a permission problem must not turn into a crash over a file
 * the caller is already treating as absent.
 */
function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove.
  }
}

function parseRequest(value: unknown): TrayRequest | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const request = record.request;
  if (request !== "hide" && request !== "show" && request !== "toggle") return null;
  return {
    request,
    nonce: typeof record.nonce === "string" ? record.nonce : "",
    requestedAt: typeof record.requestedAt === "string" ? record.requestedAt : "",
  };
}

function parseState(value: unknown): TrayState | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const { pid, hidden, updatedAt } = record;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof hidden !== "boolean") return null;
  if (typeof updatedAt !== "string") return null;
  return { pid, hidden, updatedAt };
}

/** Asks the running tray to change its icon. Overwrites any pending request. */
export function writeTrayRequest(request: TrayVisibilityRequest): TrayRequest {
  const next: TrayRequest = {
    request,
    nonce: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
  };
  writeAtomic(join(configDir(), REQUEST_FILE), next);
  return next;
}

/**
 * Takes the pending request, if any.
 *
 * The file is removed whether or not it parsed: a request nobody can act on
 * would otherwise be re-read on every poll and reported as a fresh failure each
 * time.
 */
export function consumeTrayRequest(): TrayRequest | null {
  const path = join(configDir(), REQUEST_FILE);
  const request = parseRequest(readJson(path));
  discard(path);
  return request;
}

/** Drops a pending request without acting on it. */
export function clearTrayRequest(): void {
  discard(join(configDir(), REQUEST_FILE));
}

/** Records what the tray is showing, for `carte tray status` and the CLI's wait. */
export function writeTrayState(state: { readonly pid: number; readonly hidden: boolean }): void {
  const next: TrayState = { pid: state.pid, hidden: state.hidden, updatedAt: new Date().toISOString() };
  writeAtomic(join(configDir(), STATE_FILE), next);
}

/**
 * Reads the tray's last known visibility.
 *
 * A record owned by a process that is no longer alive is a leftover from a tray
 * that exited without cleaning up — it reads as "no tray running" and is
 * removed, so `status` cannot report an icon that is not there.
 */
export function readTrayState(): TrayState | null {
  const path = join(configDir(), STATE_FILE);
  const state = parseState(readJson(path));
  if (state === null || !pidAlive(state.pid)) {
    discard(path);
    return null;
  }
  return state;
}

/** Removes the state record, so no later command reads a dead tray's icon. */
export function clearTrayState(): void {
  discard(join(configDir(), STATE_FILE));
}
