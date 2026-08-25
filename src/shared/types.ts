/**
 * Single source of truth for everything that crosses the content-script /
 * service-worker boundary. Remember: `chrome.runtime.sendMessage` JSON-serialises
 * its payload, so nothing here may be an ArrayBuffer, Blob, ImageBitmap or Map.
 */

export type Msg =
  | {
      type: "PORTAL_DEPART";
      targetUrl: string;
      /**
       * The origin of the page the gesture was made on.
       *
       * The worker cannot read it: there is no `tabs` permission, so `sender.tab`
       * carries an id and nothing else. It is needed for one decision — whether
       * the destination is same-origin with the page we are standing on — and
       * that decision is what keeps mode A from stripping a site's own CSP for a
       * frame that site already permits. See handleDepart.
       */
      pageOrigin: string | null;
      centerXFrac: number;
      centerYFrac: number;
      radiusFrac: number;
    }
  | { type: "PORTAL_COMMIT" }
  /**
   * Our own preview frame has loaded, so the header-stripping rule has done its
   * job and can go NOW rather than at commit.
   *
   * This matters: while the rule is armed, `X-Frame-Options` and
   * `frame-ancestors` are stripped for that host in this whole tab — not just
   * for our iframe. A hostile page hosting a link to the target could frame it
   * itself during the window and get an unprotected frame to clickjack. It
   * cannot be scoped tighter than a tab, so the mitigation is to make the
   * window as short as the feature allows: a few hundred milliseconds instead
   * of the whole HOLD phase.
   */
  | { type: "PORTAL_FRAMED" }
  | { type: "PORTAL_ABORT" }
  /** Not in the core protocol: radial-menu chrome. Cheap, and keeps favicon
   *  fetching on the SW side where host permissions bypass CORS (§7.6). */
  | { type: "QUICK_ICONS"; urls: string[] }
  /** Snapshot of the active tab, for the gravitational lens. Not in the core
   *  protocol; see the note on capturePage() in content/departure.ts. */
  | { type: "PAGE_CAPTURE" }
  /**
   * The tab telling the worker how big it is, to be relayed to the offscreen
   * tracker. The tracker's thresholds are in screen pixels and the shape of its
   * active box is the shape of the viewport, so it cannot map a hand onto a
   * screen it has never been told the size of. Sent when the hand trigger comes
   * up and on resize.
   */
  | { type: "HAND_VIEWPORT"; width: number; height: number };

export const DEFAULT_THEME_COLOR = "#0b0a09";

/**
 * Everything the disc needs to stand in for a page it cannot frame. Shared by
 * the depart response and by the worker's late `PORTAL_VISION` push, so the two
 * can never drift apart.
 */
export interface VisionPayload {
  imageDataUrl: string | null;
  /** "og" is a designed preview and is shown as-is; anything else gets a card. */
  imageKind: "og" | "favicon" | null;
  themeColor: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
}

export const EMPTY_VISION: VisionPayload = {
  imageDataUrl: null,
  imageKind: null,
  themeColor: DEFAULT_THEME_COLOR,
  title: null,
  description: null,
  siteName: null,
};

export type DepartResponse = { mode: "iframe" } | ({ mode: "vision" } & VisionPayload);

export type QuickIconsResponse = { icons: (string | null)[] };

export type PageCaptureResponse = { dataUrl: string | null };
