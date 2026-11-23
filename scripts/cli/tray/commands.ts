import {
  clearTrayRequest,
  readTrayState,
  writeTrayRequest,
  writeTrayState,
  type TrayRequest,
  type TrayState,
  type TrayVisibilityRequest,
} from "./control";
import type { Tray } from "./index";

/**
 * The two halves of "hide the icon": applying a request inside the tray, and
 * asking for one from another process.
 *
 * Both live here so the tray's poll loop and the CLI share one definition of
 * what a request means, and so the mapping from request to icon state can be
 * tested without a gateway, a helper, or a menu bar.
 */

/**
 * How long a command waits for the tray to confirm it acted.
 *
 * The tray polls every second and the change itself is immediate, so this is
 * several polls' worth of slack. It exists so a tray that stopped polling —
 * wedged, or replaced by a stale pid — fails the command instead of hanging it.
 */
const COMMAND_TIMEOUT_MS = 3_000;

/** How often the command re-reads the state file while it waits. */
const COMMAND_POLL_MS = 100;

export interface TrayCommandOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /** Yields between polls. Injected so tests do not wait in real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Applies one request to a live tray and reports the resulting visibility.
 *
 * `toggle` is resolved here rather than in the caller so the tray and the CLI
 * cannot disagree about what "toggle" meant at the moment it was read.
 */
export async function applyTrayVisibility(tray: Tray, request: TrayVisibilityRequest): Promise<boolean> {
  if (request === "hide") await tray.hide();
  else if (request === "show") await tray.show();
  else if (tray.isVisible()) await tray.hide();
  else await tray.show();
  return !tray.isVisible();
}

/**
 * Applies a consumed request and records the answer.
 *
 * Both halves belong together: a change without its state record leaves the
 * command that asked waiting, and a state record without the request's nonce
 * leaves it unable to tell the answer from the state that was already there.
 * A change that throws writes nothing, so a failed hide is never reported as a
 * hidden icon.
 */
export async function respondToTrayRequest(tray: Tray, request: TrayRequest): Promise<boolean> {
  const hidden = await applyTrayVisibility(tray, request.request);
  writeTrayState({ pid: process.pid, hidden, nonce: request.nonce });
  return hidden;
}

function describe(request: TrayVisibilityRequest): string {
  if (request === "hide") return "hide the icon";
  if (request === "show") return "show the icon";
  return "change the icon";
}

/**
 * Asks the running tray to change its icon and waits for it to say it did.
 *
 * The state file is the acknowledgement: without it a command would print
 * success for a request the tray never read. A command that gives up removes
 * its own request, because a request left behind would act on the tray minutes
 * later — long after the operator was told it failed.
 */
export async function requestTrayVisibility(
  request: TrayVisibilityRequest,
  options: TrayCommandOptions = {},
): Promise<TrayState> {
  if (readTrayState() === null) {
    throw new Error("No Cartethyia tray is running; start one with carte --tray");
  }
  const sent = writeTrayRequest(request);
  const desired = request === "hide" ? true : request === "show" ? false : null;
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const pollMs = options.pollMs ?? COMMAND_POLL_MS;
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const state = readTrayState();
      // The nonce is what ties this record to this request. A toggle has no
      // fixed target, so its nonce alone settles it; hide and show also check
      // that the tray ended up in the state that was asked for.
      if (state?.nonce === sent.nonce && (desired === null || state.hidden === desired)) {
        return state;
      }
      await sleep(pollMs);
    }
    throw new Error(`The tray did not ${describe(request)} within ${timeoutMs} ms`);
  } catch (error) {
    clearTrayRequest();
    throw error;
  }
}

/**
 * Runs one `carte tray` subcommand.
 *
 * Failures are reported as a one-line message and a non-zero exit code rather
 * than a stack trace: this is an operator command, and "no tray is running" is
 * an answer, not a crash.
 */
export async function runTrayCommand(command: TrayVisibilityRequest | "status"): Promise<void> {
  if (command === "status") {
    const state = readTrayState();
    if (state === null) {
      console.log("No Cartethyia tray is running.");
      return;
    }
    console.log(`Cartethyia tray is running (PID ${state.pid}); icon ${state.hidden ? "hidden" : "visible"}.`);
    return;
  }
  try {
    const state = await requestTrayVisibility(command);
    console.log(`Tray icon ${state.hidden ? "hidden" : "visible"}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "the tray command failed");
    process.exitCode = 1;
  }
}
