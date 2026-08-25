import {
  armFrameRule,
  releaseFrameRule,
  sweepAllRules,
  type FrameRuleScope,
} from "./dnr";
import { sendViewport, syncHandTracking } from "./offscreen";
import {
  buildVision,
  faviconDataUrl,
  inspectTarget,
  isSameOrigin,
  type TargetInfo,
} from "./preview";
import { MAX_QUICK_LINKS, loadSettings } from "../shared/settings";
import {
  EMPTY_VISION,
  type DepartResponse,
  type Msg,
  type PageCaptureResponse,
  type QuickIconsResponse,
  type VisionPayload,
} from "../shared/types";

/**
 * Budgets.
 *
 * These were one 350 ms number used for everything, and that number is why the
 * portal only ever previewed Wikipedia. `inspectTarget` had 350 ms to fetch the
 * destination; measured against nine popular sites, five of them needed more
 * (google 462, youtube 368, bbc 475, HN 614, stackoverflow 677). On a timeout
 * `info` comes back null, `info?.framable` is undefined, BOTH iframe branches
 * are skipped, and the disc falls through to the card. Wikipedia was the one
 * site that was fast enough AND natively framable.
 *
 * The fix is mostly not to block on the probe at all — see handleDepart — so
 * these can now be sized for what they actually are.
 */
/** Only blocks when mode A is off and we must know if the site frames natively. */
const PROBE_BUDGET_MS = 900;
/** Nothing waits on the card; it arrives when it arrives. */
const VISION_BUDGET_MS = 1500;

/** SW -> content script direction. Not part of `Msg`, which is content -> SW. */
export type SwMsg =
  | ({ type: "PORTAL_VISION" } & VisionPayload)
  /**
   * "You are the tab in front and the tracker just came up — how big are you?"
   *
   * Only the tab knows its viewport and only the worker knows when the tracker
   * starts, so neither can act alone. Without this the tracker spends its first
   * gestures mapping onto a default screen size, and the disc lands in the wrong
   * place until the user happens to resize or switch tabs.
   */
  | { type: "HAND_NEED_VIEWPORT" }
  | {
      type: "HAND_GESTURE";
      centerXFrac: number;
      centerYFrac: number;
      radiusFrac: number;
      direction: number;
      startAngle: number;
    };

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Never let a failed push reject into the worker's unhandled-rejection log. */
function pushToTab(tabId: number, msg: SwMsg): void {
  try {
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  } catch {
    /* tab gone */
  }
}

async function handleDepart(
  tabId: number,
  msg: Extract<Msg, { type: "PORTAL_DEPART" }>,
): Promise<DepartResponse> {
  const fallback: DepartResponse = { mode: "vision", ...EMPTY_VISION };

  if (!isHttpUrl(msg.targetUrl)) return fallback;

  const settings = await loadSettings();
  const pageOrigin = typeof msg.pageOrigin === "string" ? msg.pageOrigin : null;
  /**
   * How much of the destination's framing policy mode A is allowed to remove.
   *
   * A destination on the origin we are already standing on is framed in a
   * same-SITE iframe, and `SameSite=Lax` does NOT withhold cookies from one —
   * so the logged-out preview that makes stripping tolerable cross-site is not
   * what happens there. Taking the whole `content-security-policy` header off
   * an authenticated document takes `script-src` with it.
   *
   * The answer is a narrower rule, NOT a refusal to arm one. Declining outright
   * was tried and it cost the live preview on a large share of real links: it
   * pushed same-origin targets onto the probe, and the probe says no whenever
   * the destination does not answer a credential-less GET with a 200 inside the
   * budget — a page behind a login, a bot-protection interstitial, a slow host.
   * Mode A never looked at the response at all, which is exactly why it worked.
   *
   * "xfo" keeps that: armed unconditionally, no probe, but it removes only
   * X-Frame-Options and leaves the CSP — and `script-src` — untouched. See
   * FrameRuleScope in dnr.ts for why that is enough to frame nearly everything.
   */
  const scope: FrameRuleScope = isSameOrigin(msg.targetUrl, pageOrigin) ? "xfo" : "all";

  /**
   * Probe, build the card, and push it — without anyone waiting on it.
   *
   * The content script draws this preview OVER the frame until the frame is
   * worth showing, and keeps it forever if the frame never appears. So it is
   * not a fallback that might be needed; it is what is on screen first, every
   * time. That is exactly why nothing has to block on it.
   */
  const probeAndPush = (probed?: TargetInfo | null): void => {
    const info = probed !== undefined ? Promise.resolve(probed)
      : inspectTarget(msg.targetUrl, VISION_BUDGET_MS, pageOrigin);
    void info
      .then((i) => buildVision(msg.targetUrl, i, VISION_BUDGET_MS))
      .then((v) => {
        pushToTab(tabId, { type: "PORTAL_VISION", ...v });
      });
  };

  /*
   * Mode A does not need the probe.
   *
   * The old order was probe-then-decide, and the probe answered a question mode
   * A does not ask: whether the site frames on its own. Mode A strips the
   * headers either way, so the only thing waiting achieved was letting a slow
   * destination cancel its own preview.
   *
   * The one thing given up is redirects that cross hosts: the rule is armed on
   * the link's own hostname, so a shortener landing somewhere else is not
   * covered and falls back to the card.
   */
  if (settings.iframeMode) {
    if (await armFrameRule(tabId, msg.targetUrl, scope)) {
      probeAndPush();
      return { mode: "iframe" };
    }
  }

  // Mode A is off, or the rule would not install, so whether to frame at all
  // depends on the site's own headers and this is the one path that genuinely
  // has to wait for an answer. `pageOrigin` matters here too: it is what lets
  // `SAMEORIGIN` and `frame-ancestors 'self'` read as the yes they are when the
  // destination is our own origin.
  const info = await inspectTarget(msg.targetUrl, PROBE_BUDGET_MS, pageOrigin);

  if (info?.nativelyFramable && settings.livePreview) {
    probeAndPush(info);
    return { mode: "iframe" };
  }

  const vision = await buildVision(msg.targetUrl, info, VISION_BUDGET_MS);
  return { mode: "vision", ...vision };
}

async function handleQuickIcons(urls: string[]): Promise<QuickIconsResponse> {
  const capped = urls.slice(0, MAX_QUICK_LINKS);
  const icons = await Promise.all(
    capped.map((u) => (isHttpUrl(u) ? faviconDataUrl(u, 32) : Promise.resolve(null))),
  );
  return { icons };
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const msg = raw as Msg;
  const tabId = sender.tab?.id; // §4: no `tabs` permission needed for this.

  if (!msg || typeof msg.type !== "string") return false;

  switch (msg.type) {
    case "PORTAL_DEPART": {
      const bail: DepartResponse = { mode: "vision", ...EMPTY_VISION };
      if (tabId === undefined) {
        sendResponse(bail);
        return false;
      }
      handleDepart(tabId, msg)
        .then(sendResponse)
        .catch(() => sendResponse(bail));
      return true; // async
    }

    case "PORTAL_COMMIT": {
      if (tabId === undefined) {
        sendResponse({ ok: true });
        return false;
      }
      // Navigation is committing: the frame rule has done its job.
      void releaseFrameRule(tabId);
      sendResponse({ ok: true });
      return false;
    }

    case "PORTAL_FRAMED": {
      // Idempotent, and safe if it never arrives: the commit path and the 5s
      // watchdog both still release. This is the fast path, not the only one.
      if (tabId !== undefined) void releaseFrameRule(tabId);
      sendResponse({ ok: true });
      return false;
    }

    case "PORTAL_ABORT": {
      if (tabId === undefined) {
        sendResponse({ ok: true });
        return false;
      }
      void releaseFrameRule(tabId);
      sendResponse({ ok: true });
      return false;
    }

    case "PAGE_CAPTURE": {
      // The ACTIVE tab, which is the sender's own — §7.7 rules out capturing a
      // tab in the background, not this. Needs <all_urls>, not the "tabs"
      // permission. JPEG because a PNG of a full viewport is megabytes and this
      // has to cross a JSON message boundary.
      const windowId = sender.tab?.windowId;
      if (windowId === undefined) {
        sendResponse({ dataUrl: null } satisfies PageCaptureResponse);
        return false;
      }
      chrome.tabs
        .captureVisibleTab(windowId, { format: "jpeg", quality: 80 })
        .then((dataUrl) => sendResponse({ dataUrl } satisfies PageCaptureResponse))
        // Rate-limited, or the page forbids capture. The lens simply stays off.
        .catch(() => sendResponse({ dataUrl: null } satisfies PageCaptureResponse));
      return true;
    }

    case "HAND_VIEWPORT": {
      // Only the tab in front drives the tracker, and only that tab's size is
      // meaningful. A background tab reporting its own would silently re-aim the
      // gesture at a viewport nobody is looking at.
      if (tabId === undefined || !sender.tab?.active) {
        sendResponse({ ok: true });
        return false;
      }
      void sendViewport(msg.width, msg.height);
      sendResponse({ ok: true });
      return false;
    }

    case "QUICK_ICONS": {
      handleQuickIcons(Array.isArray(msg.urls) ? msg.urls : [])
        .then(sendResponse)
        .catch(() => sendResponse({ icons: [] } satisfies QuickIconsResponse));
      return true;
    }

    default:
      return false;
  }
});

/* -------------------------------------------------------------------------- *
 *  Webcam trigger
 * -------------------------------------------------------------------------- */

/**
 * The offscreen tracker has no idea which tab is in front, and its coordinates
 * are camera-space fractions. Forward them to the active tab, which maps them
 * onto its own viewport.
 */
async function forwardToActiveTab(msg: Record<string, unknown>): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    /* no injectable tab in front (chrome://, PDF viewer, web store) */
  }
}

/** syncHandTracking, plus the viewport handshake when it brings the tracker up. */
async function syncTracking(trigger: string, enabled: boolean): Promise<void> {
  if (await syncHandTracking(trigger, enabled)) {
    await forwardToActiveTab({ type: "HAND_NEED_VIEWPORT" });
  }
}

chrome.runtime.onMessage.addListener((raw, sender) => {
  const msg = raw as Record<string, unknown> & { type?: string; target?: string };
  if (!msg || msg.target === "offscreen") return false;

  // Only the offscreen document may raise these; a content script must not be
  // able to synthesise a gesture for another tab.
  const fromExtension = !sender.tab;

  // HAND_PREVIEW and HAND_ARMED are the live feedback channel; same relay, same
  // extension-only guard, so a page cannot synthesise them for another tab.
  if (
    fromExtension &&
    (msg.type === "HAND_GESTURE" ||
      msg.type === "HAND_PREVIEW" ||
      msg.type === "HAND_ARMED")
  ) {
    void forwardToActiveTab(msg);
    return false;
  }
  if (msg.type === "TRIGGER_CHANGED" && fromExtension) {
    void loadSettings().then((s) => syncTracking(s.trigger, s.enabled));
    return false;
  }
  return false;
});

// Keep the tracker in step with the setting however it changed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  void loadSettings().then((s) => syncTracking(s.trigger, s.enabled));
});

void loadSettings().then((s) => syncTracking(s.trigger, s.enabled));

/*
 * Heal on every tab switch.
 *
 * Both halves of the hand trigger can end up stale without anyone noticing:
 * the worker can be killed and restarted with the tracker down, and
 * HAND_NEED_VIEWPORT is sent to whatever tab is in front at the time — which,
 * when the trigger is changed from the options page, is the options page, an
 * extension page with no content script to answer it.
 *
 * `startHandTracking` returns immediately when the tracker is already running,
 * so this costs one message per tab switch and removes a whole class of "it
 * only works after I reload the page".
 *
 * `tabs.onActivated` carries only ids, so it needs no `tabs` permission.
 */
chrome.tabs.onActivated.addListener(() => {
  void loadSettings().then((s) => syncTracking(s.trigger, s.enabled));
});

// A tab that closes mid-portal must not strand its rule.
chrome.tabs.onRemoved.addListener((tabId) => {
  void releaseFrameRule(tabId);
});

// Session rules survive service-worker termination (they only die with the
// browser session), so a worker killed mid-portal can leak one. Sweep on every
// worker start, not just on install.
chrome.runtime.onStartup.addListener(() => void sweepAllRules());
chrome.runtime.onInstalled.addListener(() => void sweepAllRules());
void sweepAllRules();