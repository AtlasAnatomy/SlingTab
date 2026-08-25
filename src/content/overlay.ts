import { Canvas2DRenderer } from "./renderer/gl2d";
import { GLRenderer } from "./renderer/gl";
import type { SparkSystem } from "./renderer/sparks";
import { toCssColor, type PortalRenderer, type RenderState } from "./renderer/types";

/**
 * Shadow-DOM host lifecycle.
 *
 * §7.1  document.body is null at document_start -> append to documentElement.
 * §7.12 Page CSS can target our host: random-ish tag name, closed shadow root,
 *       every host property set inline with `!important` (inline `!important`
 *       outranks any author `!important`, including `* { all: unset }`).
 */

/**
 * Renderer failures used to be swallowed by bare `catch {}`, which turned a
 * shader typo into "the animation just doesn't happen" with nothing in the
 * console. These are rare and always worth surfacing.
 */
const warned = new Set<string>();
function warn(message: string, detail?: unknown): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`%cSlingTab%c ${message}`, "color:#ff8a1f;font-weight:700", "", detail);
}

function randomTag(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  // Must contain a hyphen to be parsed as an (unregistered) custom element.
  return `a-${hex}`;
}

const HOST_STYLE: Array<[string, string]> = [
  // `all: initial` first — later declarations in the same inline block win, and
  // this severs every inherited property coming from the page.
  ["all", "initial"],
  ["position", "fixed"],
  ["inset", "0px"],
  ["display", "block"],
  ["width", "100%"],
  ["height", "100%"],
  ["margin", "0px"],
  ["padding", "0px"],
  ["border", "0px"],
  ["overflow", "hidden"],
  ["pointer-events", "none"],
  ["z-index", "2147483647"],
  ["opacity", "1"],
  ["visibility", "visible"],
  ["transform", "none"],
  ["filter", "none"],
  ["clip-path", "none"],
  ["mix-blend-mode", "normal"],
  ["isolation", "isolate"],
  // `size` containment is deliberately omitted: combined with inset/100% it has
  // edge cases on zoomed viewports, and layout+style already isolate us.
  ["contain", "layout style"],
  ["color-scheme", "normal"],
];

const SHADOW_CSS = `
:host { contain: layout style; }
* { margin: 0; padding: 0; border: 0; box-sizing: border-box; }
.stack { position: absolute; inset: 0; overflow: hidden; }
.veil {
  position: absolute; inset: 0;
  background: #0b0a09;
  opacity: 0;
  will-change: opacity;
}
.portal {
  position: absolute; inset: 0;
  clip-path: circle(0px at 50% 50%);
  will-change: clip-path;
  overflow: hidden;
}
.portal iframe {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  border: 0;
  background: #0b0a09;
  /* The framed page is scenery. Making it inert is what lets mode A strip
     frame-ancestors without handing anyone a clickjacking surface, and it also
     stops a click meant to commit the portal from landing inside the preview
     instead. See mountIframe() in departure.ts. */
  pointer-events: none;
}
canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.menu { position: absolute; inset: 0; }
.chip {
  position: absolute;
  transform: translate(-50%, -50%) scale(0.6);
  opacity: 0;
  display: flex; align-items: center; gap: 8px;
  max-width: 210px;
  padding: 7px 12px 7px 8px;
  border-radius: 999px;
  background: rgba(18, 12, 6, 0.86);
  box-shadow: 0 0 0 1px rgba(255, 170, 70, 0.35), 0 6px 22px rgba(0, 0, 0, 0.55);
  color: #ffe6bf;
  font: 500 12px/1.25 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  white-space: nowrap;
  transition: transform 140ms cubic-bezier(0.23,1,0.32,1), opacity 140ms linear,
              box-shadow 140ms linear, background 140ms linear;
}
.chip.in { transform: translate(-50%, -50%) scale(1); opacity: 1; }
.chip.out {
  transform: translate(-50%, -50%) scale(0.72);
  opacity: 0;
  transition: transform 110ms cubic-bezier(0.55,0.055,0.675,0.19), opacity 90ms linear;
}
.chip.hot {
  background: rgba(52, 24, 4, 0.95);
  box-shadow: 0 0 0 1px rgba(255, 210, 122, 0.95), 0 0 22px rgba(255, 138, 31, 0.6);
  transform: translate(-50%, -50%) scale(1.09);
}
.chip img, .chip .fallback {
  width: 18px; height: 18px; border-radius: 4px; flex: 0 0 auto;
  background: rgba(255, 170, 70, 0.18);
  display: grid; place-items: center;
  font-size: 10px; color: #ffd27a;
}
.chip span { overflow: hidden; text-overflow: ellipsis; }
`;

export interface Overlay {
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot;
  /** The layer holding veil + portal + canvas. Transformed for the commit dive. */
  readonly stack: HTMLDivElement;
  readonly veil: HTMLDivElement;
  readonly portal: HTMLDivElement;
  readonly menu: HTMLDivElement;
  readonly rendererKind: "webgl2" | "canvas2d";
  setVisionImage(bitmap: ImageBitmap | null): void;
  setPageImage(bitmap: ImageBitmap | null): void;
  setTint(rgb: readonly [number, number, number]): void;
  setVeilColor(rgb: readonly [number, number, number]): void;
  render(state: RenderState, sparks: SparkSystem): void;
  resize(): void;
  destroy(): void;
}

class OverlayImpl implements Overlay {
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot;
  readonly veil: HTMLDivElement;
  readonly portal: HTMLDivElement;
  readonly menu: HTMLDivElement;

  readonly stack: HTMLDivElement;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: PortalRenderer | null = null;
  private bitmap: ImageBitmap | null = null;
  private page: ImageBitmap | null = null;
  private tint: [number, number, number] = [0.043, 0.039, 0.035];
  private destroyed = false;
  private onLost = (e: Event) => {
    // §10: swap to the 2D fallback mid-animation, without interruption.
    e.preventDefault();
    if (this.destroyed) return;
    this.swapToCanvas2D();
  };

  /**
   * `withCanvas: false` builds the host, the shadow root and the veil, and
   * skips the renderer entirely.
   *
   * The arrival animation is a masked veil and nothing else, so constructing a
   * GLRenderer for it meant compiling four shader programs at document_start on
   * every arrival — on exactly the path where the destination is supposed to
   * appear as fast as possible, to draw nothing.
   */
  constructor(withCanvas = true) {
    this.host = document.createElement(randomTag());
    for (const [prop, value] of HOST_STYLE) {
      this.host.style.setProperty(prop, value, "important");
    }
    this.host.setAttribute("aria-hidden", "true");

    this.shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = SHADOW_CSS;
    this.shadow.appendChild(style);

    this.stack = document.createElement("div");
    this.stack.className = "stack";

    this.veil = document.createElement("div");
    this.veil.className = "veil";

    this.portal = document.createElement("div");
    this.portal.className = "portal";

    this.menu = document.createElement("div");
    this.menu.className = "menu";

    this.stack.append(this.veil, this.portal);
    this.shadow.append(this.stack);

    if (withCanvas) this.mountCanvas();
    this.stack.append(this.menu);

    // §7.1: body may not exist yet.
    document.documentElement.appendChild(this.host);
    this.resize();
  }

  private mountCanvas(): void {
    let canvas = document.createElement("canvas");
    this.canvas = canvas;
    // Insert above the portal layer, below the radial menu.
    this.stack.append(canvas);
    canvas.addEventListener("webglcontextlost", this.onLost, false);

    try {
      this.renderer = new GLRenderer(canvas);
    } catch (err) {
      // GLRenderer obtains the webgl2 context before it compiles anything, so
      // by the time a shader failure throws, this canvas is already a WebGL
      // canvas and getContext("2d") on it returns null forever. Handing it to
      // the 2D renderer would throw straight back out of createOverlay() and
      // silently degrade the whole feature to a plain navigation. Swap in a
      // fresh element.
      warn("WebGL2 renderer unavailable, falling back to Canvas2D", err);
      canvas.removeEventListener("webglcontextlost", this.onLost);
      const fresh = document.createElement("canvas");
      canvas.replaceWith(fresh);
      canvas = fresh;
      this.canvas = fresh;
      this.renderer = new Canvas2DRenderer(fresh);
    }
    this.renderer.setTint(this.tint);
    if (this.bitmap) this.renderer.setVisionImage(this.bitmap);
    if (this.page) this.renderer.setPageImage(this.page);
    this.resize();
  }

  private swapToCanvas2D(): void {
    if (!this.renderer || this.renderer.kind === "canvas2d") return;
    try {
      this.renderer.dispose();
    } catch {
      /* ignore */
    }
    this.canvas?.removeEventListener("webglcontextlost", this.onLost);
    // A canvas that has held a webgl2 context can never yield a 2d one, so the
    // element itself has to be replaced.
    const fresh = document.createElement("canvas");
    this.canvas?.replaceWith(fresh);
    this.canvas = fresh;
    this.renderer = new Canvas2DRenderer(fresh);
    this.renderer.setTint(this.tint);
    if (this.bitmap) this.renderer.setVisionImage(this.bitmap);
    if (this.page) this.renderer.setPageImage(this.page);
    this.resize();
  }

  get rendererKind(): "webgl2" | "canvas2d" {
    return this.renderer?.kind ?? "canvas2d";
  }

  setVisionImage(bitmap: ImageBitmap | null): void {
    this.bitmap = bitmap;
    this.renderer?.setVisionImage(bitmap);
  }

  setPageImage(bitmap: ImageBitmap | null): void {
    this.page = bitmap;
    this.renderer?.setPageImage(bitmap);
  }

  setTint(rgb: readonly [number, number, number]): void {
    this.tint = [rgb[0], rgb[1], rgb[2]];
    this.renderer?.setTint(rgb);
  }

  setVeilColor(rgb: readonly [number, number, number]): void {
    this.veil.style.background = toCssColor(rgb);
  }

  render(state: RenderState, sparks: SparkSystem): void {
    if (this.destroyed || !this.renderer) return;
    try {
      this.renderer.render(state, sparks);
    } catch (err) {
      // A lost context can surface as a throw before the event lands.
      warn("renderer threw mid-frame, swapping to Canvas2D", err);
      this.swapToCanvas2D();
    }
  }

  resize(): void {
    if (!this.renderer) return;
    this.renderer.resize(
      window.innerWidth,
      window.innerHeight,
      window.devicePixelRatio || 1,
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.canvas?.removeEventListener("webglcontextlost", this.onLost);
      this.renderer?.dispose();
    } catch {
      /* ignore */
    }
    this.bitmap?.close?.();
    this.bitmap = null;
    this.page?.close?.();
    this.page = null;
    this.host.remove();
  }
}

export function createOverlay(withCanvas = true): Overlay | null {
  try {
    return new OverlayImpl(withCanvas);
  } catch (err) {
    // Returning null here degrades the portal to a plain navigation, so this is
    // exactly the failure that must never be silent.
    warn("could not build the overlay; navigating without animation", err);
    return null;
  }
}