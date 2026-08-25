import { Departure, type QuickTarget } from "./departure";
import { GestureBuffer, type GestureResult } from "./gesture";
import { HandPreview } from "./handpreview";
import { send } from "./messaging";
import { edgeClamp } from "../shared/handmap";
import {
  DEFAULT_SETTINGS,
  MAX_QUICK_LINKS,
  loadSettings,
  onSettingsChanged,
  type Settings,
} from "../shared/settings";
import {
  DEFAULT_THEME_COLOR,
  type PageCaptureResponse,
  type QuickIconsResponse,
} from "../shared/types";

/* ========================================================================== *
 *  DEPARTURE — gesture capture and portal launch.
 * ========================================================================== */

const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

function isTopLevelWebPage(): boolean {
  try {
    if (window.top !== window.self) return false;
    return location.protocol === "http:" || location.protocol === "https:";
  } catch {
    return false;
  }
}

let settings: Settings = { ...DEFAULT_SETTINGS };
const buffer = new GestureBuffer();
let active: Departure | null = null;

/** Per-press flag: only swallow contextmenu if this press produced a portal. */
let gestureFired = false;
let gestureFiredAt = 0;
let capturing = false;

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** §6 step 1: nearest ancestor <a href> with an http(s) href under the centre. */
function linkAt(x: number, y: number): string | null {
  try {
    const stack = document.elementsFromPoint(x, y);
    for (const el of stack) {
      const anchor = (el as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) continue;
      const href = anchor.href;
      if (/^https?:\/\//i.test(href) && href !== location.href) return href;
    }
  } catch {
    /* elementsFromPoint can throw on detached documents */
  }
  return null;
}

/**
 * §6 step 1 widened for the hand trigger.
 *
 * With a mouse the user puts the cursor on the thing they want, so the centre
 * point is the target. A hand in the air maps to a screen position that is only
 * roughly where they mean, and landing exactly on a link is luck. Sample a
 * spiral inside the disc and take the nearest link found.
 */
function linkNear(x: number, y: number, radius: number): string | null {
  const direct = linkAt(x, y);
  if (direct) return direct;

  const rings = [0.3, 0.55, 0.8];
  const spokes = 12;
  for (const rf of rings) {
    const r = radius * rf;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2;
      const hit = linkAt(x + Math.cos(a) * r, y + Math.sin(a) * r);
      if (hit) return hit;
    }
  }
  return null;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function quickTargets(): Promise<QuickTarget[]> {
  const links = settings.quickLinks.slice(0, MAX_QUICK_LINKS);
  if (!links.length) return [];
  const res = await send<QuickIconsResponse>({
    type: "QUICK_ICONS",
    urls: links.map((l) => l.url),
  });
  return links.map((l, i) => ({
    url: l.url,
    label: l.label || hostLabel(l.url),
    icon: res?.icons?.[i] ?? null,
  }));
}

function resetGesture(): void {
  buffer.clear();
  capturing = false;
}

/* -------------------------------------------------------------------------- *
 *  Hand trigger: live feedback
 * -------------------------------------------------------------------------- */

let handPreview: HandPreview | null = null;
let pendingCapture: Promise<string | null> | null = null;
let lastCaptureAt = 0;

/* -------------------------------------------------------------------------- *
 *  Hand trigger: telling the tracker how big this tab is
 *
 *  The offscreen tracker maps a region of the camera frame onto the whole
 *  viewport, and sizes that region to the viewport's aspect ratio so a circle
 *  drawn in the air stays a circle on screen. It cannot do either without
 *  knowing what "the viewport" currently is, and it has no way to ask — an
 *  offscreen document has no access to tabs. So the tab volunteers it.
 * -------------------------------------------------------------------------- */

let reportedViewport = "";
let viewportTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * `force` skips the settings check, for the one case where the worker has told
 * us the tracker is running: it knows that before our own settings listener has
 * necessarily fired, and refusing to answer on stale local state is exactly how
 * the tracker would end up stuck on a default screen size.
 */
function reportViewport(force = false): void {
  if (!force && (!settings.enabled || settings.trigger !== "hand")) return;
  // Only the visible tab drives the tracker; the worker rejects the rest anyway.
  if (document.visibilityState !== "visible") return;

  const width = window.innerWidth;
  const height = window.innerHeight;
  if (!width || !height) return;

  const key = `${width}x${height}`;
  if (key === reportedViewport) return;
  reportedViewport = key;
  void send({ type: "HAND_VIEWPORT", width, height }, 800);
}

/** Resize fires continuously through a window drag; one report per settle. */
function scheduleViewportReport(): void {
  if (viewportTimer !== null) clearTimeout(viewportTimer);
  viewportTimer = setTimeout(reportViewport, 250);
}

/**
 * Becoming the front tab means the tracker is now aimed at us, whatever it was
 * last told. Clearing the memo forces a report even when this tab happens to be
 * the same size as the one the user just left.
 */
function reportViewportFresh(force = false): void {
  reportedViewport = "";
  reportViewport(force);
}

/**
 * captureVisibleTab is rate-limited (a couple of calls a second) and throws
 * past that, so arming and disarming repeatedly must not spam it.
 */
function requestCapture(): Promise<string | null> {
  lastCaptureAt = performance.now();
  return send<PageCaptureResponse>({ type: "PAGE_CAPTURE" }, 1500).then(
    (r) => r?.dataUrl ?? null,
  );
}

function onHandArmed(armed: boolean): void {
  if (active) return;
  if (!armed) {
    handPreview?.destroy();
    handPreview = null;
    return;
  }
  // Snapshot now, while nothing of ours is on screen yet — a capture taken
  // after the preview ring exists would bake that ring into the lens texture.
  if (!pendingCapture || performance.now() - lastCaptureAt > 2500) {
    pendingCapture = requestCapture();
  }
  if (!handPreview?.alive) handPreview = new HandPreview();
}

async function fire(gesture: GestureResult, wideSearch = false): Promise<void> {
  // Callers replace an existing portal before firing; this only catches a race.
  replaceActive();
  gestureFired = true;
  gestureFiredAt = performance.now();
  resetGesture();

  // FIRST, before any overlay is built: the lens needs a picture of the page
  // without our own ring already burned into it. In hand mode the snapshot was
  // already taken when the pose armed, for the same reason.
  const capture = pendingCapture ?? requestCapture();
  pendingCapture = null;

  // The preview ring is mid-flight; adopt its overlay rather than rebuild.
  const adopt = handPreview?.release() ?? null;
  handPreview = null;

  const link = wideSearch
    ? linkNear(gesture.centerX, gesture.centerY, gesture.radius)
    : linkAt(gesture.centerX, gesture.centerY);

  // §7.13: reduced motion means no animation at all, just go.
  if (prefersReducedMotion()) {
    if (link) location.href = link;
    return;
  }

  const targets = link ? [] : await quickTargets();
  // §6 step 3: nothing to navigate to and nothing to offer — let it dissipate.

  const departure: Departure = new Departure({
    gesture,
    settings,
    linkUrl: link,
    quickTargets: targets,
    capture,
    adopt,
    // Identity-checked: a portal being replaced finishes its dissipate AFTER
    // its successor is already live, and an unguarded `active = null` would
    // then blank out the new one.
    onFinished: () => {
      if (active === departure) active = null;
    },
  });
  // The constructor can bail out synchronously (no overlay -> plain navigation),
  // in which case onFinished already fired before we could assign. Assigning
  // unconditionally would strand `active` and block every later gesture.
  active = departure.isFinished ? null : departure;
}

function sample(e: PointerEvent): void {
  if (active) return;
  const g = buffer.feed(
    { x: e.clientX, y: e.clientY, t: e.timeStamp || performance.now() },
    viewport(),
  );
  if (g) void fire(g);
}

/**
 * A portal that is open must not block the next one.
 *
 * The portal now waits instead of closing itself after four seconds, so
 * "already active" stopped being a transient state and started being a wall:
 * without this, drawing a second circle did nothing at all until the first
 * portal was dismissed by hand.
 *
 * `active` is cleared here rather than in the dissipate callback, because that
 * callback fires 380 ms later — long enough to swallow the whole of the next
 * gesture's samples.
 */
function replaceActive(): void {
  if (!active) return;
  active.dismiss();
  active = null;
}

function onPointerDown(e: PointerEvent): void {
  if (!settings.enabled) return;
  if (settings.trigger === "right") {
    if (e.button !== 2) return;
    replaceActive();
    capturing = true;
    gestureFired = false;
    buffer.clear();
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!settings.enabled || active) return;
  if (settings.trigger === "alt") {
    if (!e.altKey) {
      if (buffer.length) buffer.clear();
      return;
    }
  } else if (!capturing) {
    return;
  }
  sample(e);
}

function onPointerUp(): void {
  logGesture();
  resetGesture();
}

/**
 * Turned on from the options page. Prints, once per attempted gesture, exactly
 * which criterion in §5 failed — so "it does nothing" becomes a number.
 */
function logGesture(): void {
  if (!settings.debug || active) return;
  if (buffer.length < 8) return;
  const e = buffer.explain(viewport());
  const rows: Record<string, string> = {};
  for (const [name, c] of Object.entries(e.checks)) {
    rows[name] = `${c.ok ? "OK  " : "FAIL"}  ${c.value.toFixed(2)}  (need ${c.need})`;
  }
  console.groupCollapsed(
    `%cSlingTab%c gesture ${e.fired ? "recognised" : "rejected"} — ${buffer.length} samples`,
    "color:#ff8a1f;font-weight:700",
    "color:inherit",
  );
  console.table(rows);
  if (e.trimmed) console.log(`lead-in trimmed: ${e.trimmed} samples`);
  console.log("metrics", e.metrics);
  console.groupEnd();
}

function onContextMenu(e: MouseEvent): void {
  if (settings.trigger !== "right") return;
  // Only swallow the menu when this press actually produced a portal —
  // otherwise the user loses their context menu everywhere.
  if (gestureFired && performance.now() - gestureFiredAt < 1200) {
    e.preventDefault();
    e.stopPropagation();
  }
  gestureFired = false;
}

function onKeyUp(e: KeyboardEvent): void {
  if (settings.trigger === "alt" && e.key === "Alt") resetGesture();
}

function installListeners(): void {
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
  window.addEventListener("contextmenu", onContextMenu, true);
  window.addEventListener("keyup", onKeyUp, true);
  // NOT capture. `blur` does not bubble, but a capture-phase listener on window
  // still receives every element's blur on the way down — so with capture on,
  // any focus change mid-drag (and pressing a mouse button often causes one)
  // wiped the buffer and the gesture could never complete. Without capture we
  // only get the window's own blur, which is what "user left the tab" means.
  window.addEventListener("blur", resetGesture);
  // The preview ring must never outlive the document that owns it.
  window.addEventListener("pagehide", () => {
    handPreview?.destroy();
    handPreview = null;
  }, true);

  window.addEventListener("resize", scheduleViewportReport);
  // Wrapped, not passed directly: the listener's Event argument would land in
  // `force` and turn every focus into an unconditional report.
  window.addEventListener("focus", () => reportViewportFresh());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reportViewportFresh();
  });
}

// The SW pushes preview data after the fact when mode A is in play and the
// content script may still need to fall back to mode C (§7.10).
function installPush(): void {
  try {
    chrome.runtime.onMessage.addListener((raw) => {
      const msg = raw as {
        type?: string;
        imageDataUrl?: string | null;
        imageKind?: "og" | "favicon" | null;
        themeColor?: string;
        title?: string | null;
        description?: string | null;
        siteName?: string | null;
        pointerXFrac?: number;
        pointerYFrac?: number;
        centerXFrac?: number | null;
        centerYFrac?: number | null;
        radiusFrac?: number | null;
        direction?: number;
        startAngle?: number;
        progress?: number;
        armed?: boolean;
      };

      if (msg?.type === "PORTAL_VISION" && active) {
        active.applyVision({
          imageDataUrl: msg.imageDataUrl ?? null,
          imageKind: msg.imageKind ?? null,
          themeColor: msg.themeColor ?? DEFAULT_THEME_COLOR,
          title: msg.title ?? null,
          description: msg.description ?? null,
          siteName: msg.siteName ?? null,
        });
        return false;
      }

      // The tracker just came up and does not know how big this tab is. Handled
      // above the trigger check, and forced past our own: the worker only asks
      // because it has already started the tracker, so it is a better authority
      // on the current trigger than a `settings` copy that may not have been
      // refreshed yet.
      if (msg?.type === "HAND_NEED_VIEWPORT") {
        reportViewportFresh(true);
        return false;
      }

      // A circle drawn in the air. The tracker works in fractions of the
      // viewport we reported, so these land on this tab 1:1.
      // Everything below this line is hand-trigger only.
      if (settings.trigger !== "hand") return false;

      if (msg?.type === "HAND_ARMED") {
        onHandArmed(msg.armed === true);
        return false;
      }

      if (msg?.type === "HAND_PREVIEW") {
        if (active || !settings.enabled) return false;
        if (!handPreview?.alive) handPreview = new HandPreview();
        handPreview.update({
          pointerXFrac: msg.pointerXFrac ?? 0.5,
          pointerYFrac: msg.pointerYFrac ?? 0.5,
          centerXFrac: msg.centerXFrac ?? null,
          centerYFrac: msg.centerYFrac ?? null,
          radiusFrac: msg.radiusFrac ?? null,
          startAngle: msg.startAngle ?? 0,
          direction: msg.direction ?? 1,
          progress: msg.progress ?? 0,
        });
        return false;
      }

      if (msg?.type === "HAND_GESTURE") {
        if (!settings.enabled) return false;
        replaceActive();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // The tracker measured this against the viewport we reported, so the
        // clamps below should never bite. They stay as a guard for the window
        // that exists between a resize and the next report landing.
        const radius = Math.min(
          0.45 * Math.min(vw, vh),
          Math.max(60, (msg.radiusFrac ?? 0.2) * vw),
        );
        void fire(
          {
            centerX: edgeClamp((msg.centerXFrac ?? 0.5) * vw, radius, vw),
            centerY: edgeClamp((msg.centerYFrac ?? 0.5) * vh, radius, vh),
            radius,
            direction: msg.direction ?? 1,
            startAngle: msg.startAngle ?? 0,
          },
          true,
        );
      }
      return false;
    });
  } catch {
    /* context invalidated */
  }
}

if (isTopLevelWebPage()) {
  installListeners();
  installPush();
  void loadSettings().then((s) => {
    settings = s;
    reportViewportFresh();
  });
  onSettingsChanged((s) => {
    const wasHand = settings.enabled && settings.trigger === "hand";
    settings = s;
    // Switching the trigger on is the moment the tracker starts caring.
    if (!wasHand) reportViewportFresh();
  });
}