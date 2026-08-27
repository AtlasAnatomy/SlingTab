import { Departure, type QuickTarget } from "./departure";
import { GestureBuffer, type GestureResult } from "./gesture";
import { HandPreview } from "./handpreview";
import { send } from "./messaging";
import { PortalRegistry, screenIsDirty } from "./portals";
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

/**
 * Every portal that has not finished yet. See portals.ts for why this is not
 * simply `active`: a single reference cannot survive a race, and two separate
 * ones stranded portals on screen that no gesture, click or key could close.
 */
const live = new PortalRegistry();

/** Per-press flag: only swallow contextmenu if this press produced a portal. */
let gestureFired = false;
let gestureFiredAt = 0;
let capturing = false;

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * True when `href` addresses the document we are already in.
 *
 * Not just the identical URL: anything differing only in the fragment is a
 * SAME-DOCUMENT navigation. Nothing unloads, so the portal would dive into a
 * page that never arrives and hold the last frame of the dive over the tab —
 * see T_WAIT_MAX in departure.ts, which is the other half of this. Every table
 * of contents and every anchored heading on the web is one of these links, so
 * it is not an edge case: it is the commonest link on a documentation page.
 *
 * The portal has nothing to show for one either. There is no destination to
 * frame and no preview to build — it is this page, scrolled.
 */
function isSameDocument(href: string): boolean {
  const bare = (u: string): string => u.split("#")[0] ?? u;
  return bare(href) === bare(location.href);
}

/** §6 step 1: nearest ancestor <a href> with an http(s) href under the centre. */
function linkAt(x: number, y: number): string | null {
  try {
    const stack = document.elementsFromPoint(x, y);
    for (const el of stack) {
      const anchor = (el as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) continue;
      const href = anchor.href;
      if (/^https?:\/\//i.test(href) && !isSameDocument(href)) return href;
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

/**
 * False once this script has been orphaned by an extension reload or update.
 *
 * Chrome does not stop an old content script when the extension behind it goes
 * away. It invalidates its `chrome.*` APIs and leaves everything else running —
 * so the window listeners installed below keep firing, the recogniser keeps
 * recognising, and `fire()` keeps building portals that can no longer reach the
 * worker for a preview, a capture or a header rule.
 *
 * That was survivable while it was the only script on the page. It stops being
 * survivable now that the worker injects a live script into open tabs on
 * install: the two would draw a ring each. Reading `chrome.runtime.id` is the
 * cheapest way to ask, and on an invalidated context it is undefined.
 */
function extensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- *
 *  Hand trigger: live feedback
 * -------------------------------------------------------------------------- */

let handPreview: HandPreview | null = null;
let pendingCapture: Promise<string | null> | null = null;
let lastCaptureAt = 0;

/**
 * A gesture that has been recognised but whose portal does not exist yet.
 *
 * `fire()` is async, and between releasing the preview overlay and assigning
 * `active` it awaits the quick-link icons — a message to the worker with a two
 * second timeout. For that whole window `active` and `handPreview` are BOTH
 * null, which is a lie: a portal is on its way.
 *
 * Everything that reads `active` to mean "nothing of ours is on screen" was
 * therefore free to act during it. A second gesture ran `replaceActive()`
 * against a null `active`, found nothing to close, and built its own portal —
 * leaving the first one orphaned with nobody holding it, its identity-checked
 * `onFinished` unable to ever match, and its rAF loop and overlay running until
 * T_HOLD_MAX five minutes later. That is the two-ring screenshot: one portal
 * with quick-link chips, one without, neither able to close the other.
 *
 * `firing` closes the window for anything that would draw. `fireSeq` settles
 * the race when it happens anyway: the newest gesture wins and older ones
 * abandon what they were building.
 */
let fireSeq = 0;
let firing = false;

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
  // A snapshot of the old viewport is the wrong shape for the new one.
  cleanCapture = null;
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

/**
 * The last snapshot taken with nothing of ours on screen.
 *
 * `captureVisibleTab` photographs the COMPOSITED tab, and our overlay is part
 * of the page — so a snapshot taken while a ring is visible contains that ring.
 * The lens then draws that photograph inside the next portal, and the ring is
 * back: not as an overlay this time, but as pixels in a texture. Nothing owns
 * it, nothing redraws it, no teardown can remove it. Do it again and the next
 * photograph contains both, then three, then four.
 *
 * That is what was still filling the screen after the overlays themselves had
 * started being destroyed correctly — the rings were coming back inside the
 * picture of the page.
 */
let cleanCapture: Promise<string | null> | null = null;
/** When the last overlay stopped being on screen. */
let overlayGoneAt = 0;

/**
 * Is anything of ours painted right now?
 *
 * The grace period matters as much as the count. Removing an overlay does not
 * repaint the tab — the compositor gets to that on its own schedule — so a
 * capture requested immediately after a teardown still photographs the ring
 * that was just removed.
 */
function overlayVisible(): boolean {
  return screenIsDirty({
    overlays: live.size,
    preview: handPreview !== null,
    sinceGoneMs: performance.now() - overlayGoneAt,
  });
}

/**
 * A snapshot with nothing of ours in it, or the last one that was.
 *
 * Reusing is not a compromise: scrolling is locked while a portal is open, so
 * the previous clean snapshot is still a true picture of what lies underneath.
 * And no lens at all beats a lens full of our own rings.
 */
function pageCapture(): Promise<string | null> {
  if (overlayVisible()) return cleanCapture ?? Promise.resolve(null);
  cleanCapture = requestCapture();
  return cleanCapture;
}

function onHandArmed(armed: boolean): void {
  // `firing` as well as `active`: a portal under construction is still a portal.
  if (active || firing) return;
  if (!armed) {
    handPreview?.destroy();
    handPreview = null;
    return;
  }
  // Snapshot now, while nothing of ours is on screen yet. `pageCapture` is what
  // enforces that: re-arming with a preview still up reuses the clean one
  // rather than photographing its embers.
  if (!pendingCapture || performance.now() - lastCaptureAt > 2500) {
    pendingCapture = pageCapture();
  }
  if (!handPreview?.alive) handPreview = new HandPreview();
}

async function fire(gesture: GestureResult, wideSearch = false): Promise<void> {
  const resolveLink = (): string | null =>
    wideSearch
      ? linkNear(gesture.centerX, gesture.centerY, gesture.radius)
      : linkAt(gesture.centerX, gesture.centerY);

  // Orphaned by a reload or an update: everything a portal needs is gone, so
  // do the one thing that still works and get out of the way.
  if (!extensionAlive()) {
    const dead = resolveLink();
    if (dead) location.href = dead;
    return;
  }

  const seq = ++fireSeq;
  firing = true;

  /*
   * The capture is decided BEFORE anything is torn down, and that ordering is
   * the whole fix.
   *
   * `pageCapture` refuses to photograph the tab while one of our overlays is on
   * it. Asking after `replaceActive()` would defeat that twice over: `live` is
   * already empty so it would look clean, and the compositor has not repainted
   * anyway, so the photograph would still contain the ring we just removed.
   * That ring then becomes the lens texture of the portal being built — which
   * is how rings kept coming back as frozen pixels after the overlays
   * themselves were being destroyed correctly.
   */
  const capture = pendingCapture ?? pageCapture();
  pendingCapture = null;

  replaceActive();
  gestureFired = true;
  gestureFiredAt = performance.now();
  resetGesture();

  // The preview ring is mid-flight; adopt its overlay rather than rebuild.
  const adopt = handPreview?.release() ?? null;
  handPreview = null;

  try {
    const link = resolveLink();

    // §7.13: reduced motion means no animation at all, just go.
    if (prefersReducedMotion()) {
      // The adopted overlay is ours now. Returning without it would leave the
      // hand preview's ring on the page with nothing left to take it down.
      adopt?.destroy();
      if (link) location.href = link;
      return;
    }

    const targets = link ? [] : await quickTargets();
    // §6 step 3: nothing to navigate to and nothing to offer — let it dissipate.

    // A newer gesture started while the icons were in flight. It has already
    // run `replaceActive()` against an `active` we had not assigned yet, so
    // building this portal now would strand one of the two on screen for good.
    // The newest gesture is the one the user meant; this one steps aside.
    if (seq !== fireSeq) {
      adopt?.destroy();
      return;
    }

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
        live.remove(departure);
        if (active === departure) active = null;
      },
    });
    // Registered before `active`, and unconditionally: a portal that exists
    // must be reachable even if the assignment below decides it is not the
    // active one.
    if (!departure.isFinished) live.add(departure);
    // The constructor can bail out synchronously (no overlay -> plain
    // navigation), in which case onFinished already fired before we could
    // assign. Assigning unconditionally would strand `active` and block every
    // later gesture.
    active = departure.isFinished ? null : departure;
  } finally {
    // Only the newest gesture may reopen the window. An older one clearing it
    // here would let a preview ring appear underneath the portal that
    // superseded it — the same two-ring bug, one level down.
    if (seq === fireSeq) firing = false;
  }
}

function sample(e: PointerEvent): void {
  // `firing` too: `fire()` clears the buffer on entry, so without this a fast
  // pointer can refill it and fire a SECOND gesture during the await inside the
  // first — which is exactly the race that stranded a portal on screen.
  if (active || firing) return;
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
  active = null;
  if (live.size) overlayGoneAt = performance.now();
  live.closeAll();
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
        // The tracker keeps streaming at 22 Hz through the whole of `fire()`.
        // Without `firing`, one of those frames lands in the window where
        // `active` is not assigned yet and builds a preview overlay alongside
        // the portal being constructed.
        if (active || firing || !settings.enabled) return false;
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
        // No `replaceActive()` here: `fire()` does it, and doing it first would
        // empty `live` before `fire` can see that a portal is on screen — which
        // is exactly what it needs to know to refuse a dirty capture. Not gated
        // on `firing` either: dropping the gesture would leave the previous
        // portal open and open nothing new, which reads as being ignored.
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