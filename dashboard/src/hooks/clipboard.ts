/**
 * Clipboard writes, owned by the pattern that reports them.
 *
 * Every copy affordance in the dashboard goes through `useClipboard` or calls
 * {@link copyToClipboard} directly, so one place decides how a write happens
 * and the origin/permission failure is answered once, as "Clipboard unavailable
 * on this origin".
 *
 * `navigator.clipboard` exists only in a secure context: on an `http://` origin
 * other than `localhost` it is missing outright, which is why a bare
 * `navigator.clipboard.writeText` at a call site silently does nothing there.
 * The fallback below writes through a hidden textarea and
 * `document.execCommand("copy")`, which browsers still honour inside the click
 * that asked for it. It runs synchronously in that click when the async API is
 * absent, so no `await` spends the transient activation the command needs.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Insecure origin, denied permission, or no user activation: fall through.
    }
  }
  return copyWithoutClipboardApi(value);
}

/** Copies through a temporary selection, restoring the reader's focus afterwards. */
function copyWithoutClipboardApi(value: string): boolean {
  const body = document.body;
  if (body === null) return false;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const previousRange = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.width = "1px";
  area.style.height = "1px";
  area.style.padding = "0";
  area.style.border = "none";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  body.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (previousRange !== null && selection !== null) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    active?.focus({ preventScroll: true });
  }
}
