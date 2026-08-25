import { clamp01, easeInCubic, easeOutCubic, easeOutQuint } from "../shared/easing";
import { MAX_QUICK_LINKS, type Settings } from "../shared/settings";
import type { DepartResponse, VisionPayload } from "../shared/types";
import type { GestureResult } from "./gesture";
import { send } from "./messaging";
import { createOverlay, type Overlay } from "./overlay";
import { SPARK_TUNING, SparkSystem } from "./renderer/sparks";
import { parseColor, type RenderState } from "./renderer/types";
import { composeVisionCard } from "./visioncard";

const T_IGNITE = 220;
const T_OPEN = 180;
/**
 * The portal is not on a countdown any more.
 *
 * It used to close itself after 4 s, which was long enough to look finished and
 * far too short to be useful: a heavy destination had not painted yet, and you
 * could not simply look at the thing you had opened. It now waits, and closes
 * when you say so — a click outside, any key, a scroll, leaving the tab, or
 * drawing another circle.
 *
 * This remains only as a safety valve, so a portal cannot outlive the interest
 * of whoever opened it by an unbounded amount.
 */
const T_HOLD_MAX = 5 * 60_000;
/** Commit = lens phase + dive phase. */
const T_LENS = 260;
const T_DIVE = 320;
const T_COMMIT = T_LENS + T_DIVE;
const T_FLARE = 120;
const T_DISSIPATE = 380;

/**
 * When to show the framed destination, and when to give up on it.
 *
 * `load` is the wrong thing to wait for. It fires only once the document AND
 * every subresource has arrived — two to five seconds on a real site — so gating
 * the reveal on it meant the portal closed before the page it had fetched ever
 * appeared. That is why the disc showed a blurred card almost every time.
 *
 * So: reveal optimistically. By ~700 ms a site has painted something, and
 * watching the rest arrive inside the disc looks like the page swimming into
 * focus rather than like a bug. `load` still counts — it just accelerates the
 * reveal instead of gating it.
 *
 * GIVE_UP covers the one case nothing else catches: a frame that will never
 * paint at all (§7.10 — a site served by its own service worker never hits the
 * network, so no DNR rule can apply). If `load` has not fired by then, fall
 * back to the card.
 */
const IFRAME_REVEAL_DELAY = 700;
const IFRAME_GIVE_UP = 5000;
/** Dissolve, not a cut: a hard swap inside a small disc reads as a glitch. */
const T_VISION_FADE = 320;
const COMMIT_SPEED = 200; // px/s
const CHIP_HIT_RADIUS = 54;

/** Steady bend while the portal waits: a gravity well, not a fisheye. */
const LENS_IDLE = 0.055;
const LENS_PEAK = 0.62;
const SWIRL_PEAK = 0.20;
const DIVE_ZOOM = 3.1;

type Phase = "IGNITE" | "OPEN" | "HOLD" | "COMMIT" | "WAITING" | "DISSIPATE" | "DONE";

export interface QuickTarget {
  url: string;
  label: string;
  icon: string | null;
}

export interface DepartureOptions {
  gesture: GestureResult;
  settings: Settings;
  /** Resolved link under the disc centre, or null to show the radial menu. */
  linkUrl: string | null;
  quickTargets: QuickTarget[];
  /**
   * Snapshot of the page for the lens, requested by the caller BEFORE this
   * overlay exists. Taken any later and the capture contains our own ring,
   * which then ghosts underneath the real one.
   */
  capture: Promise<string | null>;
  /**
   * An overlay already on screen — the hand preview's traced ring. Adopting it
   * instead of building a new one is what keeps the handover from dropping a
   * frame and restarting the arc at zero.
   */
  adopt?: Overlay | null;
  onFinished: () => void;
}

interface Chip {
  el: HTMLDivElement;
  url: string;
  x: number;
  y: number;
}


export class Departure {
  private overlay: Overlay | null;
  private sparks = new SparkSystem();
  private raf = 0;
  private t0 = 0;
  private last = 0;

  private phase: Phase = "IGNITE";
  private phaseStart = 0;

  private cx: number;
  private cy: number;
  private radius: number;

  private targetUrl: string | null;
  private mode: "vision" | "iframe" = "vision";
  private iframe: HTMLIFrameElement | null = null;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private giveUpTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once the frame has actually fired `load`, as opposed to being shown. */
  private frameLoaded = false;
  /** When the dissolve from card to page started. */
  private revealAt = 0;
  /**
   * The framed page has fired `load` and may be revealed.
   *
   * Until it does, the disc keeps drawing the composed preview OVER the frame.
   * That is what removed the need to guess a timeout: there is never an empty
   * portal to protect against, because something correct is always on screen,
   * and the live page simply replaces it whenever it turns up.
   */
  private frameReady = false;
  private departSeq = 0;

  private chips: Chip[] = [];
  private hotChip: Chip | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;

  private pointerX = 0;
  private pointerY = 0;
  private pointerSpeed = 0;
  private pointerT = 0;
  private hasCrossed = false;


  /** Snapshot of the page, for the lens. Null until the capture lands. */
  private hasPage = false;
  private prefetched: string | null = null;
  private injected: Element[] = [];
  private navigated = false;
  private finished = false;

  /** True when the constructor bailed out before starting anything. */
  get isFinished(): boolean {
    return this.finished;
  }

  constructor(private opts: DepartureOptions) {
    const g = opts.gesture;
    this.cx = g.centerX;
    this.cy = g.centerY;
    this.radius = g.radius;
    this.targetUrl = opts.linkUrl;

    this.overlay = opts.adopt ?? createOverlay();
    if (!this.overlay) {
      // Could not build the overlay at all: degrade to a plain navigation.
      if (this.targetUrl) location.href = this.targetUrl;
      opts.onFinished();
      this.finished = true;
      return;
    }

    this.pointerX = this.cx;
    this.pointerY = this.cy;

    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("click", this.onClick, true);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("resize", this.onResize, true);
    window.addEventListener("pagehide", this.onPageHide, true);

    this.t0 = performance.now();
    this.last = this.t0;
    this.phaseStart = this.t0;
    // The hand preview already traced this ring at full radius. Blooming out
    // from a point now would snap it back to 2px and start over, which is the
    // most visible frame in the whole sequence to drop.
    if (opts.adopt) this.phase = "OPEN";
    this.raf = requestAnimationFrame(this.frame);

    void this.capturePage();
    if (this.targetUrl) this.prefetch(this.targetUrl);
    if (this.targetUrl) void this.depart(this.targetUrl);
  }

  // ------------------------------------------------------------- networking

  /**
   * Snapshot the page so the lens has something to bend.
   *
   * captureVisibleTab grabs the ACTIVE tab, which is this one — §7.7 only rules
   * out capturing a tab in the background. It is the piece that makes the whole
   * effect possible: once the page is a texture, the dive is GPU work on a quad
   * instead of a transform fighting the site's own CSS and layout.
   *
   * The image never leaves the machine and is dropped when the portal closes.
   * The request itself is issued by the caller before the overlay is built.
   */
  private async capturePage(): Promise<void> {
    const dataUrl = await this.opts.capture;
    if (!dataUrl || this.finished || !this.overlay) return;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const bmp = await createImageBitmap(blob);
      if (this.finished || !this.overlay) {
        bmp.close();
        return;
      }
      this.overlay.setPageImage(bmp);
      this.hasPage = true;
      // The snapshot is frozen; letting the page scroll under it would desync
      // the two instantly.
      this.lockScroll();
    } catch {
      /* no lens; the veil path still works */
    }
  }

  private scrollLocked = false;

  private lockScroll(): void {
    if (this.scrollLocked) return;
    this.scrollLocked = true;
    window.addEventListener("wheel", this.blockScroll, { passive: false, capture: true });
    window.addEventListener("touchmove", this.blockScroll, { passive: false, capture: true });
  }

  private unlockScroll(): void {
    if (!this.scrollLocked) return;
    this.scrollLocked = false;
    window.removeEventListener("wheel", this.blockScroll, true);
    window.removeEventListener("touchmove", this.blockScroll, true);
  }

  private async depart(url: string): Promise<void> {
    const seq = ++this.departSeq;

    /*
     * Everything in the disc belongs to the PREVIOUS target and is now wrong.
     *
     * Hovering from one quick-link chip to another used to leave the first
     * frame mounted and `frameReady` already true, so `mountIframe` appended a
     * second frame on top of it with nothing covering it while it loaded. What
     * you saw was either the old site or a blank disc, and it never changed to
     * the new one. Tearing down first puts the composed card back over the hole
     * and lets the reveal run again from the beginning.
     */
    this.tearDownIframe();
    this.overlay?.setVisionImage(null);

    const res = await send<DepartResponse>({
      type: "PORTAL_DEPART",
      targetUrl: url,
      centerXFrac: this.cx / window.innerWidth,
      centerYFrac: this.cy / window.innerHeight,
      radiusFrac: this.radius / window.innerWidth,
    });
    if (seq !== this.departSeq || this.finished || !this.overlay) return;
    if (!res) return; // dead worker: the disc stays as a tinted wash

    if (res.mode === "iframe") {
      this.mode = "iframe";
      this.mountIframe(url);
      return;
    }
    this.applyVision(res);
  }

  /** Also used for the SW's late PORTAL_VISION push in iframe mode. */
  applyVision(v: VisionPayload): void {
    if (!this.overlay || this.finished) return;
    const rgb = parseColor(v.themeColor);
    this.overlay.setTint(rgb);
    this.overlay.setVeilColor(rgb);

    void (async () => {
      // fetch() in the isolated world is not subject to the page's CSP, and a
      // data: URL is same-origin — so this never taints the canvas (§7.6).
      const decode = async (dataUrl: string): Promise<ImageBitmap | null> => {
        try {
          return await createImageBitmap(await (await fetch(dataUrl)).blob());
        } catch {
          return null;
        }
      };

      const image = v.imageDataUrl ? await decode(v.imageDataUrl) : null;

      // A real og:image was designed to be a preview; show it. A favicon was
      // designed to be 32px in a tab strip, and stretching it over the disc
      // reads as a smear — so it becomes the icon on a composed card instead.
      let bmp: ImageBitmap | null;
      if (v.imageKind === "og" && image) {
        bmp = image;
      } else {
        bmp = await composeVisionCard({
          hostname: this.hostname(),
          // A page with neither og:title nor a <title> is unusual, but the
          // fallbacks cost nothing and an empty card is the worst outcome here.
          title: v.title ?? v.siteName ?? v.description,
          icon: image,
          rgb,
        });
        image?.close?.();
      }

      if (!bmp) return;
      if (this.finished || !this.overlay) {
        bmp.close();
        return;
      }
      this.overlay.setVisionImage(bmp);
    })();
  }

  private hostname(): string {
    try {
      return new URL(this.targetUrl ?? "").hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  private mountIframe(url: string): void {
    if (!this.overlay) return;
    const frame = document.createElement("iframe");
    /*
     * This is a PREVIEW, not a browser. It exists for the second or two the
     * portal is open and is never meant to be used, which is what makes the
     * header stripping behind mode A acceptable: removing `frame-ancestors`
     * from a site that refused framing re-opens the door to clickjacking, and
     * an iframe nobody can click is not a clickjacking surface.
     *
     * So `pointer-events: none` in the shadow CSS, no `allow-forms`, no
     * `allow-popups`, and no `allow-top-navigation` — the last of which is also
     * what stops a frame-busting script from hijacking the user's tab.
     *
     * `allow-same-origin` stays: without it the frame lands in an opaque origin
     * and a large share of sites throw on their own storage access and render
     * nothing. It grants the frame its own origin's cookies, not ours, and
     * SameSite=Lax withholds session cookies from a cross-site frame anyway —
     * which is why the preview shows the logged-out page (§7.9).
     */
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("tabindex", "-1");
    frame.setAttribute("aria-hidden", "true");
    frame.src = url;

    frame.addEventListener("load", () => this.onFrameLoad(), { once: true });
    frame.addEventListener("error", () => this.tearDownIframe(), { once: true });

    /*
     * The one failure we can detect immediately and precisely.
     *
     * Our DNR rule strips the DESTINATION's headers. It cannot touch the CSP of
     * the page we are injected into, and a host page with `frame-src 'self'`
     * (GitHub, X, most banks) blocks this iframe outright — no `error` event,
     * just a frame that never loads. Chrome does fire a securitypolicyviolation
     * on the host document, so we hear about it in a millisecond instead of
     * sitting behind a blank frame.
     */
    document.addEventListener("securitypolicyviolation", this.onCspViolation, true);

    // Show it before it has finished; see the note on IFRAME_REVEAL_DELAY.
    this.revealTimer = setTimeout(() => this.revealFrame(), IFRAME_REVEAL_DELAY);
    this.giveUpTimer = setTimeout(() => {
      if (!this.frameLoaded) this.tearDownIframe();
    }, IFRAME_GIVE_UP);

    this.iframe = frame;
    this.overlay.portal.appendChild(frame);
  }

  private onFrameLoad(): void {
    this.frameLoaded = true;
    if (this.giveUpTimer !== null) {
      clearTimeout(this.giveUpTimer);
      this.giveUpTimer = null;
    }
    document.removeEventListener("securitypolicyviolation", this.onCspViolation, true);
    this.revealFrame();
    // The rule stripped the headers for this request and is now pure exposure —
    // see the note on PORTAL_FRAMED in shared/types.ts.
    void send({ type: "PORTAL_FRAMED" }, 500);
  }

  /** Start the dissolve from the composed card to the live page. */
  private revealFrame(): void {
    if (this.frameReady || this.finished || !this.iframe) return;
    this.frameReady = true;
    this.revealAt = performance.now();
    if (this.revealTimer !== null) {
      clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
  }

  /**
   * How much of the composed preview is still covering the frame.
   *
   * 1 while there is no frame, or none worth showing yet; runs to 0 over
   * T_VISION_FADE once one is revealed.
   */
  private visionCover(now: number): number {
    if (this.mode === "vision" || !this.frameReady) return 1;
    return 1 - clamp01((now - this.revealAt) / T_VISION_FADE);
  }

  private onCspViolation = (e: SecurityPolicyViolationEvent): void => {
    const directive = (e.effectiveDirective || e.violatedDirective || "").toLowerCase();
    if (!directive.startsWith("frame-src") && !directive.startsWith("child-src")) return;
    this.tearDownIframe();
  };

  private tearDownIframe(): void {
    for (const t of [this.revealTimer, this.giveUpTimer]) if (t !== null) clearTimeout(t);
    this.revealTimer = null;
    this.giveUpTimer = null;
    document.removeEventListener("securitypolicyviolation", this.onCspViolation, true);
    this.frameReady = false;
    this.frameLoaded = false;
    if (this.iframe) {
      this.iframe.src = "about:blank";
      this.iframe.remove();
      this.iframe = null;
    }
    this.mode = "vision"; // mode C takes over; the wash is already correct
  }

  // ------------------------------------------------------------ radial menu

  private buildMenu(): void {
    if (!this.overlay || this.chips.length || !this.opts.quickTargets.length) return;
    const targets = this.opts.quickTargets.slice(0, MAX_QUICK_LINKS);
    const n = targets.length;
    const pad = 12;

    targets.forEach((t, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const x = Math.min(
        window.innerWidth - pad,
        Math.max(pad, this.cx + Math.cos(a) * this.radius),
      );
      const y = Math.min(
        window.innerHeight - pad,
        Math.max(pad, this.cy + Math.sin(a) * this.radius),
      );

      const el = document.createElement("div");
      el.className = "chip";
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;

      if (t.icon) {
        const img = document.createElement("img");
        img.src = t.icon;
        img.alt = "";
        el.appendChild(img);
      } else {
        const fb = document.createElement("div");
        fb.className = "fallback";
        fb.textContent = (t.label[0] ?? "?").toUpperCase();
        el.appendChild(fb);
      }
      const span = document.createElement("span");
      span.textContent = t.label;
      el.appendChild(span);

      this.overlay!.menu.appendChild(el);
      requestAnimationFrame(() => el.classList.add("in"));
      this.chips.push({ el, url: t.url, x, y });
    });
  }

  private updateHover(): void {
    if (!this.chips.length) return;
    let best: Chip | null = null;
    let bestD = CHIP_HIT_RADIUS;
    for (const c of this.chips) {
      const d = Math.hypot(this.pointerX - c.x, this.pointerY - c.y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best === this.hotChip) return;

    this.hotChip?.el.classList.remove("hot");
    this.hotChip = best;
    best?.el.classList.add("hot");

    if (this.hoverTimer !== null) clearTimeout(this.hoverTimer);
    if (!best) return;

    // Settle before committing to a target, so sweeping past chips on the way
    // to the one you want does not fire a preview fetch for every chip.
    const url = best.url;
    this.hoverTimer = setTimeout(() => {
      if (this.finished || this.targetUrl === url) return;
      this.targetUrl = url;
      this.prefetch(url);
      void this.depart(url);
    }, 120);
  }

  // ---------------------------------------------------------------- pointer

  private onPointerMove = (e: PointerEvent): void => {
    const now = performance.now();
    const dt = Math.max(1, now - this.pointerT);
    const dx = e.clientX - this.pointerX;
    const dy = e.clientY - this.pointerY;
    if (this.pointerT > 0) {
      const inst = (Math.hypot(dx, dy) / dt) * 1000;
      this.pointerSpeed = this.pointerSpeed * 0.6 + inst * 0.4;
    }
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    this.pointerT = now;

    this.updateHover();

    if (this.phase !== "HOLD") return;
    const inside = Math.hypot(e.clientX - this.cx, e.clientY - this.cy) < this.radius;
    if (inside && this.pointerSpeed > COMMIT_SPEED && this.targetUrl) {
      this.hasCrossed = true;
      this.beginCommit();
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (this.committed || this.phase === "DISSIPATE") return;
    const inside = Math.hypot(e.clientX - this.cx, e.clientY - this.cy) < this.radius;
    const onChip = this.chips.some(
      (c) => Math.hypot(e.clientX - c.x, e.clientY - c.y) < CHIP_HIT_RADIUS,
    );
    if (!inside && !onChip) {
      // A click outside the portal means "no thanks".
      this.beginDissipate();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  private onClick = (e: MouseEvent): void => {
    if (this.phase !== "HOLD" && this.phase !== "OPEN") return;
    const inside = Math.hypot(e.clientX - this.cx, e.clientY - this.cy) < this.radius;
    if (!inside) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.targetUrl) this.beginCommit();
  };

  /**
   * Any key closes it, not just Escape.
   *
   * The portal now waits indefinitely, so it needs to be as easy to put away as
   * it was to open. Reaching for the keyboard at all means attention has moved
   * on — and a user who does not know Escape is the magic key should not be
   * stuck with a disc over their page.
   */
  private onKeyDown = (): void => this.beginDissipate();

  /**
   * Scroll is BLOCKED while the portal is open, and does not dismiss it.
   *
   * The lens bends a frozen snapshot of the page, so letting it scroll
   * underneath would desync the two instantly. Dismissing on scroll was the
   * easy way out of that and it broke the rule above: the disc closed on
   * something the user did not mean as "close".
   */
  private blockScroll = (e: Event): void => e.preventDefault();

  /**
   * Close it from outside — the content script calls this when a new circle is
   * drawn, so the second gesture replaces the first rather than being ignored.
   */
  dismiss(): void {
    this.beginDissipate();
  }

  private onResize = (): void => this.overlay?.resize();

  private onPageHide = (): void => this.teardown();

  // ----------------------------------------------------------------- phases

  private hideChips(): void {
    for (const c of this.chips) {
      c.el.classList.remove("in", "hot");
      c.el.classList.add("out");
    }
    if (this.hoverTimer !== null) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    this.hotChip = null;
  }

  /**
   * Warm the destination while the animation plays.
   *
   * Without this the dive finishes and then the browser starts the request from
   * cold, so the last frame sits frozen for however long the site takes. Both
   * of these are hints: if the page's CSP rejects the speculation rules script,
   * or the browser ignores the prefetch, nothing breaks.
   */
  private prefetch(url: string): void {
    if (this.prefetched === url) return;
    this.prefetched = url;
    try {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = url;
      link.setAttribute("as", "document");
      document.head?.appendChild(link);
      this.injected.push(link);

      /*
       * Prerender when we are allowed to, prefetch when we are not.
       *
       * Prerender is the only hint that removes the wait entirely: the
       * destination is rendered in the background and the navigation swaps to a
       * finished document. Chrome restricts cross-site prerendering to targets
       * that opt in with `Supports-Loading-Mode: credentialed-prerender`, which
       * essentially nothing does, so asking for it off-origin just gets the rule
       * rejected. Same-origin is where it actually lands, and same-origin
       * link-to-link is most of what anyone circles.
       *
       * Cross-origin gets prefetch, which is a hint the browser may decline:
       * cache partitioning often means the prefetched body is not reused for the
       * top-level navigation. That is why the WAITING phase exists at all.
       */
      let sameOrigin = false;
      try {
        sameOrigin = new URL(url).origin === location.origin;
      } catch {
        sameOrigin = false;
      }
      const rules = document.createElement("script");
      rules.type = "speculationrules";
      rules.textContent = JSON.stringify(
        sameOrigin
          ? { prerender: [{ urls: [url], eagerness: "immediate" }] }
          : { prefetch: [{ urls: [url], eagerness: "immediate" }] },
      );
      document.head?.appendChild(rules);
      this.injected.push(rules);
    } catch {
      /* hints only */
    }
  }

  /**
   * Past this point the navigation is already on its way and the portal must
   * not be torn down, restarted, or dismissed by a stray click or blur.
   * Keeping it as one predicate is why WAITING could not be forgotten in one of
   * three separate guard lists.
   */
  private get committed(): boolean {
    return this.phase === "COMMIT" || this.phase === "WAITING" || this.phase === "DONE";
  }

  private setPhase(p: Phase, now: number): void {
    this.phase = p;
    this.phaseStart = now;
  }

  private beginCommit(): void {
    if (this.committed || !this.targetUrl) return;
    const now = performance.now();
    this.setPhase("COMMIT", now);
    this.sparks.emitBurst(this.cx, this.cy, this.radius, 2600, 420);
    // The radial menu is DOM, sitting above the canvas. Without this it stayed
    // at full opacity, floating over the dive, long after everything else had
    // gone — it was only being dismissed on the dissipate path.
    this.hideChips();

    // The veil is driven from `fade` in frame(), for both the captured and the
    // uncaptured case. It used to be a one-shot WAAPI animation gated on
    // `!hasPage`, which meant the normal path never animated it at all.

    // At the end of the dive: tell the worker, then navigate on its ack. If the
    // worker is dead the wrapper resolves null on its own timeout and we go
    // anyway — a dead worker must never block navigation.
    setTimeout(() => {
      void send<{ ok: true }>({ type: "PORTAL_COMMIT" }, 400).then(() => this.navigate());
    }, T_COMMIT);
    // Belt and braces if the timer above is throttled.
    setTimeout(() => this.navigate(), T_COMMIT + 700);
  }

  private navigate(): void {
    if (this.navigated || !this.targetUrl) return;
    this.navigated = true;
    try {
      location.href = this.targetUrl;
    } catch {
      this.beginDissipate();
    }
  }

  private beginDissipate(): void {
    if (this.committed || this.phase === "DISSIPATE") return;
    this.setPhase("DISSIPATE", performance.now());
    this.sparks.emitBurst(this.cx, this.cy, this.radius, 1800, 300);
    void send({ type: "PORTAL_ABORT" });
    this.hideChips();
  }

  // ------------------------------------------------------------------ frame

  /**
   * Continuous shedding from a random point on the rim. Scattering the emission
   * point every frame rather than emitting a ring's worth at once is what keeps
   * the spray uneven — a uniform halo is the thing that looks fake.
   */
  private shed(dt: number, rate: number): void {
    this.sparks.emitAtRimRate(
      this.cx,
      this.cy,
      this.radius,
      Math.random() * Math.PI * 2,
      this.opts.gesture.direction,
      rate,
      dt,
      SPARK_TUNING.shedSpeed,
      SPARK_TUNING.shedSpread,
    );
  }

  private frame = (now: number): void => {
    if (this.finished) return;
    this.raf = requestAnimationFrame(this.frame);

    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const elapsed = now - this.t0;
    const inPhase = now - this.phaseStart;

    let progress = 1;
    let open = 0;
    let energy = 1;
    let dissipate = 0;
    /** Live radius. IGNITE blooms it out; the dive expands it past the viewport. */
    let radius = this.radius;
    let lens = 0;
    let swirl = 0;
    let zoom = 1;
    let hole = 0;
    let fade = 0;
    const viewportR = Math.hypot(window.innerWidth, window.innerHeight);

    switch (this.phase) {
      case "IGNITE": {
        // §9 specifies an arc tracing 0 -> 2*PI from startAngle. Overridden on
        // direct instruction: the ring now blooms outward from the centre, which
        // is what throws the sparks radially and makes them read as long hair
        // rather than as a swept tail. The full circle is lit from frame one.
        const t = clamp01(elapsed / T_IGNITE);
        const grow = easeOutQuint(t);
        radius = Math.max(2, this.radius * grow);
        energy = 0.25 + 0.75 * easeOutCubic(t);

        // Emitted all the way round the expanding rim, and given the rim's own
        // outward velocity so the strands trail behind the wavefront.
        const rimSpeed = (this.radius / (T_IGNITE / 1000)) * (1 - t) * 0.55;
        this.sparks.emitAtRimRate(
          this.cx, this.cy, radius,
          Math.random() * Math.PI * 2, this.opts.gesture.direction,
          SPARK_TUNING.rateIgnite, dt,
          SPARK_TUNING.igniteSpeed + rimSpeed, SPARK_TUNING.igniteSpread,
        );
        if (elapsed >= T_IGNITE) this.setPhase("OPEN", now);
        break;
      }

      case "OPEN": {
        open = easeOutQuint(clamp01(inPhase / T_OPEN));
        energy = 1;
        lens = LENS_IDLE * open;
        hole = radius * open;
        this.shed(dt, SPARK_TUNING.rateOpen);
        if (inPhase >= T_OPEN) {
          this.setPhase("HOLD", now);
          this.buildMenu();
        }
        break;
      }

      case "HOLD": {
        open = 1;
        energy = 1;
        // The well breathes, so the page around the disc never looks static.
        lens = LENS_IDLE * (0.85 + 0.15 * Math.sin(elapsed / 620));
        swirl = 0.012;
        hole = radius;
        // The ONLY things that close this are a click outside the disc and a
        // key. Not a blur, not a scroll, not a timer, and not "there was
        // nothing to travel to" — a disc you did not ask to close should not
        // close itself while you are looking at it.
        //
        // T_HOLD_MAX is a safety valve, not a policy: an rAF loop and a live
        // iframe should not outlive the tab by an unbounded amount.
        if (inPhase > T_HOLD_MAX && !this.hasCrossed) this.beginDissipate();
        // The rim never stops burning while it waits for the cursor.
        this.shed(dt, SPARK_TUNING.rateHold);
        break;
      }

      case "COMMIT": {
        open = 1;
        const flare = clamp01(inPhase / T_FLARE);
        energy = 1 + 1.4 * Math.sin(flare * Math.PI);

        if (inPhase < T_LENS) {
          // Phase 1 — the well deepens. The page bends into the disc while the
          // disc itself stays put, so it reads as the portal pulling on space
          // rather than as the camera moving.
          const t = easeInCubic(clamp01(inPhase / T_LENS));
          lens = LENS_IDLE + (LENS_PEAK - LENS_IDLE) * t;
          swirl = SWIRL_PEAK * t;
          hole = radius;
          zoom = 1 + 0.10 * t;
        } else {
          // Phase 2 — the dive. Everything rushes past while the hole opens out
          // past the corners of the viewport, so the destination takes over.
          const t = easeInCubic(clamp01((inPhase - T_LENS) / T_DIVE));
          lens = LENS_PEAK * (1 - t * 0.65);
          swirl = SWIRL_PEAK * (1 - t * 0.5);
          zoom = 1.1 + (DIVE_ZOOM - 1.1) * t;
          hole = radius + (viewportR * 1.15 - radius) * t;
          radius = hole;
          // Wash to the destination colour only at the very end, so the arrival
          // animation on the next page starts from the same frame.
          fade = clamp01((t - 0.72) / 0.28);
          // The ring goes out with the wash. It is already expanding past the
          // corners, but leaving it at full energy meant the last thing on
          // screen before the flat colour was a bright rim tearing off the
          // edges of the viewport.
          energy *= 1 - fade;
          if (inPhase >= T_COMMIT) this.setPhase("WAITING", now);
        }
        break;
      }

      case "WAITING": {
        /*
         * The dive has landed but the destination document has not.
         *
         * This used to put a ring BACK on screen — `radius = viewportR * 0.2`
         * with its own energy and 520 sparks a second — so after the zoom had
         * carried the ring off the edges, a second one faded in at the centre
         * and sat there breathing until the page arrived. That is the "it
         * freezes with the ring still visible" in the middle of the dive.
         *
         * Nothing is drawn here now. The veil is opaque in the destination's
         * colour, which is exactly the frame the arrival animation opens from,
         * and sparks still in flight from the dive finish falling and stop.
         */
        open = 1;
        fade = 1;
        energy = 0;
        // Hold the dive's final geometry. Collapsing the radius to 0 here would
        // clip the framed destination away and expose the page we are leaving,
        // one frame before the navigation replaces it.
        radius = viewportR * 1.15;
        hole = radius;
        break;
      }

      case "DISSIPATE": {
        const d = clamp01(inPhase / T_DISSIPATE);
        lens = LENS_IDLE * (1 - d);
        hole = radius * (1 - easeInCubic(d));
        open = 1 - easeInCubic(d);
        dissipate = d;
        energy = 1 - d;
        if (d >= 1) {
          this.teardown();
          return;
        }
        break;
      }

      case "DONE":
        return;
    }

    this.sparks.update(dt);

    const spin = (elapsed / 1000) * 0.15;
    const cover = this.visionCover(now);
    const state: RenderState = {
      timeSec: elapsed / 1000,
      cx: this.cx,
      cy: this.cy,
      radius,
      progress,
      startAngle: this.opts.gesture.startAngle,
      direction: this.opts.gesture.direction,
      energy,
      spin,
      dissipate,
      open,
      // The composed preview stays on top of the frame until the frame is worth
      // seeing, then dissolves. Something correct is on screen the whole time,
      // so a slow destination costs nothing.
      showVision: cover > 0.001,
      visionFade: cover,
      lens: this.hasPage ? lens : 0,
      swirl,
      zoom,
      hole,
      fade,
    };

    if (this.overlay) {
      if (this.mode === "iframe") {
        // `radius`, not `this.radius`. During the dive the local one tracks the
        // hole out past the corners while the field stays at the drawn size, so
        // the framed destination used to sit in a small disc in the middle of a
        // screen it was supposed to be swallowing.
        this.overlay.portal.style.clipPath =
          `circle(${(radius * open).toFixed(2)}px at ${this.cx.toFixed(1)}px ${this.cy.toFixed(1)}px)`;

      } else if (this.overlay.portal.style.clipPath) {
        this.overlay.portal.style.clipPath = "circle(0px at 50% 50%)";
      }

      /*
       * The veil is NEVER raised here.
       *
       * It used to ramp to opaque across the last third of the dive so the
       * departure could hand over to an arrival animation that opened from a
       * flat colour. That animation is gone (bug 33), so all the wash did was
       * put a black screen between the destination you could already see inside
       * the disc and the same destination arriving for real — which is the
       * "double blackout".
       *
       * The dive expands the disc until it is the whole screen. Whatever is in
       * it — the framed page, or the composed card — simply stays there while
       * the navigation swaps the real document in underneath.
       */

      this.overlay.render(state, this.sparks);
    }
  };

  // --------------------------------------------------------------- teardown

  teardown(): void {
    if (this.finished) return;
    this.finished = true;
    this.phase = "DONE";

    cancelAnimationFrame(this.raf);
    if (this.hoverTimer !== null) clearTimeout(this.hoverTimer);
    this.tearDownIframe();
    this.unlockScroll();
    for (const el of this.injected) el.remove();
    this.injected = [];

    window.removeEventListener("pointermove", this.onPointerMove, true);
    window.removeEventListener("pointerdown", this.onPointerDown, true);
    window.removeEventListener("click", this.onClick, true);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("resize", this.onResize, true);
    window.removeEventListener("pagehide", this.onPageHide, true);



    this.overlay?.destroy();
    this.overlay = null;
    this.opts.onFinished();
  }
}