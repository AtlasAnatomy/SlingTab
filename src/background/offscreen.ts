/**
 * Offscreen document lifecycle for the webcam trigger.
 *
 * Exactly one offscreen document may exist per extension, and creating a second
 * one throws — so every path goes through `ensure()`, which is guarded by a
 * single in-flight promise.
 */

const PATH = "src/offscreen/hand.html";

let creating: Promise<void> | null = null;

async function exists(): Promise<boolean> {
  try {
    // getContexts is the supported check; older builds fall back to clients.
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function ensure(): Promise<boolean> {
  if (await exists()) return true;
  if (creating) {
    await creating;
    return exists();
  }
  creating = chrome.offscreen
    .createDocument({
      url: PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification:
        "Watches the webcam locally for a circular hand gesture. No video leaves the device.",
    })
    .catch(() => {
      /* a concurrent create won the race, or offscreen is unavailable */
    })
    .finally(() => {
      creating = null;
    }) as Promise<void>;

  await creating;
  return exists();
}

export async function startHandTracking(): Promise<boolean> {
  if (!(await ensure())) return false;
  try {
    const res = (await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "HAND_START",
    })) as { ok?: boolean } | undefined;
    return res?.ok === true;
  } catch {
    return false;
  }
}

export async function stopHandTracking(): Promise<void> {
  if (!(await exists())) return;
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "HAND_STOP" });
  } catch {
    /* already gone */
  }
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* already closed */
  }
}

/**
 * Tell the tracker how big the tab it is driving is.
 *
 * Deliberately does NOT call `ensure()`: a viewport update must never be the
 * thing that opens the camera. If there is no tracker running there is nothing
 * to inform, and `start()` will ask for the size itself.
 */
export async function sendViewport(width: number, height: number): Promise<void> {
  if (!(await exists())) return;
  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "HAND_VIEWPORT",
      width,
      height,
    });
  } catch {
    /* document gone between the check and the send */
  }
}

/**
 * Bring the tracker in line with the current trigger setting.
 *
 * Returns true when the tracker is now running, which is the caller's cue to go
 * and ask the active tab for its size — the tracker cannot map a hand onto a
 * screen whose dimensions it has never been told.
 */
export async function syncHandTracking(
  trigger: string,
  enabled: boolean,
): Promise<boolean> {
  if (enabled && trigger === "hand") return startHandTracking();
  await stopHandTracking();
  return false;
}
