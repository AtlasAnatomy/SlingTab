/**
 * Offscreen document lifecycle for the webcam trigger.
 *
 * Exactly one offscreen document may exist per extension, and creating a second
 * one throws — so every path goes through `ensure()`, which is guarded by a
 * single in-flight promise.
 */

const PATH = "src/offscreen/hand.html";

/**
 * Session-storage key remembering whether a tracker was ever brought up.
 *
 * `syncHandTracking` runs on every tab switch — that is what heals a worker
 * restarted with the tracker down — and on the default mouse trigger its entire
 * job is to stop a tracker that was never started. Answering that question used
 * to cost a `chrome.runtime.getContexts()` round trip every single time a user
 * changed tabs, for a feature most of them never turn on.
 *
 * `chrome.storage.session` is in memory, extension-only, survives worker
 * termination and dies with the browser session — which is exactly the lifetime
 * of an offscreen document, so the flag cannot outlive what it describes.
 *
 * It is only ever allowed to SKIP work, never to start or keep the camera:
 * a read that fails answers "yes, check properly", the flag is raised BEFORE a
 * document can exist, and it is lowered from `exists()` rather than from the
 * mere fact that a close was attempted.
 */
const TRACKING_KEY = "slingtab:tracking";

let creating: Promise<void> | null = null;

/**
 * Could an offscreen document be alive right now?
 *
 *   absent  a start was never attempted this browser session, and only
 *           `startHandTracking` creates the document — and it raises the flag
 *           first. Nothing to stop.
 *   true    a start was attempted. Ask the browser.
 *   false   a stop completed and `exists()` confirmed it. Nothing to stop.
 *   throws  session storage is unavailable, which also means the flag was never
 *           written in the first place. Ask the browser.
 */
async function mayBeRunning(): Promise<boolean> {
  try {
    const got = await chrome.storage.session.get(TRACKING_KEY);
    return got?.[TRACKING_KEY] === true;
  } catch {
    return true;
  }
}

async function markTracking(on: boolean): Promise<void> {
  try {
    await chrome.storage.session.set({ [TRACKING_KEY]: on });
  } catch {
    /* session storage unavailable; every path still works, just not as cheaply */
  }
}

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
  // Raised before the document can exist, so the stop path can never be skipped
  // over a live camera because a write landed a moment too late.
  await markTracking(true);
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
  if (!(await exists())) {
    await markTracking(false);
    return;
  }
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
  // From what the browser reports, not from the fact that a close was tried: a
  // close that silently failed must not be recorded as a tracker that is gone.
  await markTracking(await exists());
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
  // The tab-switch path for everyone on the default trigger. There is nothing
  // to stop unless something was started, and the flag answers that from memory
  // instead of asking the browser to enumerate contexts.
  if (!(await mayBeRunning())) return false;
  await stopHandTracking();
  return false;
}
