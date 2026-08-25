import { DEFAULT_THEME_COLOR } from "../shared/types";

/**
 * Framability probe + preview extraction, all inside the service worker.
 *
 * §7.3 There is no DOMParser and no XMLHttpRequest in a service worker. Two
 *      meta tags do not justify the lifecycle cost of an offscreen document
 *      (`reasons: ["DOM_PARSER"]` is the sanctioned path when you genuinely
 *      need real parsing — this is not that), so: regex over the first 64 KB.
 * §7.4 `URL.createObjectURL` does not exist here either. ArrayBuffer -> base64
 *      by hand, chunked, then a `data:` URL.
 * §7.6 Fetching here is the whole point: host permissions bypass CORS in the
 *      worker, and a `data:` URL is same-origin and untainted when it reaches
 *      the content script's canvas.
 */

const HTML_BYTE_LIMIT = 64 * 1024;
const IMAGE_BYTE_LIMIT = 512 * 1024;
const B64_CHUNK = 8192;

export interface TargetInfo {
  finalUrl: string;
  /**
   * Framable if we strip X-Frame-Options / CSP for it (mode A).
   *
   * This is NOT the same as `nativelyFramable`, and it used to be assigned the
   * same value — which quietly made mode A dead code: it could only ever engage
   * for sites that were already framable, i.e. exactly the ones `livePreview`
   * had already handled. Stripping is what makes a refusing site framable, so
   * the only question left is whether we got a response at all.
   */
  framable: boolean;
  /** Framable as-is, with nothing stripped and no DNR rule created. */
  nativelyFramable: boolean;
  imageUrl: string | null;
  themeColor: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
}

/** What the disc shows when the destination cannot be framed. */
export interface Vision {
  imageDataUrl: string | null;
  /**
   * Where the image came from. A real og:image is a designed preview and is
   * shown as-is; a favicon is a 32px logo that looks like nothing stretched
   * across a disc, so the content script composes a card around it instead.
   */
  imageKind: "og" | "favicon" | null;
  themeColor: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
}

/** Blurred hard by vision.frag, so anything longer is wasted bytes. */
const TITLE_LIMIT = 90;
const DESC_LIMIT = 160;

function tidy(s: string | null, limit: number): string | null {
  if (!s) return null;
  const t = decodeEntities(s).replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > limit ? `${t.slice(0, limit - 1).trimEnd()}…` : t;
}

function deadline(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, cancel: () => clearTimeout(t) };
}

/** Read at most `limit` bytes, then cancel the stream. */
async function readCapped(res: Response, limit: number): Promise<Uint8Array> {
  const body = res.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= limit) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  const out = new Uint8Array(Math.min(total, limit));
  let off = 0;
  for (const c of chunks) {
    if (off >= out.length) break;
    const take = Math.min(c.byteLength, out.length - off);
    out.set(c.subarray(0, take), off);
    off += take;
  }
  return out;
}

// ---------------------------------------------------------------- regex layer

const META_TAG = /<meta\b[^>]*>/gi;
const LINK_TAG = /<link\b[^>]*>/gi;
const ATTR = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/g;

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(tag))) {
    out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

const TITLE_TAG = /<title[^>]*>([\s\S]*?)<\/title>/i;

export interface PreviewMeta {
  imageUrl: string | null;
  themeColor: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
}

export function extractPreview(html: string, baseUrl: string): PreviewMeta {
  const metas: Record<string, string>[] = [];
  META_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = META_TAG.exec(html))) metas.push(attrs(m[0]));

  const metaByKey = (keys: string[]): string | null => {
    for (const key of keys) {
      for (const a of metas) {
        const id = (a["property"] ?? a["name"] ?? a["itemprop"] ?? "").toLowerCase();
        if (id === key && a["content"]) return decodeEntities(a["content"]);
      }
    }
    return null;
  };

  // Priority order per §8: og:image -> twitter:image -> apple-touch-icon.
  let img =
    metaByKey(["og:image:secure_url", "og:image:url", "og:image"]) ??
    metaByKey(["twitter:image", "twitter:image:src"]);

  if (!img) {
    LINK_TAG.lastIndex = 0;
    let best: { href: string; size: number } | null = null;
    while ((m = LINK_TAG.exec(html))) {
      const a = attrs(m[0]);
      const rel = (a["rel"] ?? "").toLowerCase();
      if (!rel.includes("apple-touch-icon") || !a["href"]) continue;
      const size = parseInt((a["sizes"] ?? "0").split("x")[0] ?? "0", 10) || 0;
      if (!best || size > best.size) best = { href: decodeEntities(a["href"]), size };
    }
    img = best?.href ?? null;
  }

  const themeColor = metaByKey(["theme-color"]);

  // Open Graph first, then Twitter, then the document's own <title>. The last
  // one is a fallback rather than a preference: it is often padded with the site
  // name and a separator, which reads badly at the size the disc shows it.
  const title =
    tidy(metaByKey(["og:title", "twitter:title"]), TITLE_LIMIT) ??
    tidy(TITLE_TAG.exec(html)?.[1] ?? null, TITLE_LIMIT);
  const description = tidy(
    metaByKey(["og:description", "twitter:description", "description"]),
    DESC_LIMIT,
  );
  const siteName = tidy(metaByKey(["og:site_name", "application-name"]), TITLE_LIMIT);

  let resolved: string | null = null;
  if (img) {
    try {
      const u = new URL(img, baseUrl);
      // http(s) only. A `data:` og:image would hand an arbitrary blob of up to
      // a megabyte straight to `createImageBitmap` in the content script, from
      // a site chosen by whoever wrote the page we are standing on. Real sites
      // do not serve og:image as a data URL, so refusing costs nothing and
      // removes an input class.
      if (u.protocol === "http:" || u.protocol === "https:") {
        resolved = u.href;
      }
    } catch {
      resolved = null;
    }
  }

  return {
    imageUrl: resolved,
    themeColor: normaliseColor(themeColor) ?? DEFAULT_THEME_COLOR,
    title,
    description,
    siteName,
  };
}

export function normaliseColor(input: string | null): string | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  // `theme-color` can carry a media query list in some documents; take the head.
  const head = s.split(/[;\n]/)[0]!.trim();
  if (/^#[0-9a-f]{3,8}$/.test(head)) return head;
  if (/^rgba?\([^)]+\)$/.test(head)) return head;
  if (/^[a-z]{3,20}$/.test(head)) return head;
  return null;
}

/**
 * True when `url` is same-origin with `origin`. A missing or unparseable origin
 * is "no", so every caller degrades to the cross-origin answer it used to give.
 */
export function isSameOrigin(url: string, origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * CSP `frame-ancestors` decides framability regardless of X-Frame-Options.
 * Anything narrower than a wildcard excludes a chrome-extension initiator.
 *
 * `sameOrigin` says the page doing the framing is the destination's own origin,
 * which is the one case `'self'` exists to allow. Without it this answered for
 * the cross-site portal only — correct there, and wrong for the commonest link
 * of all: a sibling page on the site you are already reading. That wrong answer
 * is what sent same-origin links down mode A, stripping a site's CSP to build a
 * frame the site was already willing to grant.
 */
export function cspAllowsFraming(csp: string | null, sameOrigin = false): boolean {
  if (!csp) return true;
  for (const directive of csp.split(";")) {
    const parts = directive.trim().split(/\s+/);
    const name = (parts[0] ?? "").toLowerCase();
    if (name !== "frame-ancestors") continue;
    const values = parts.slice(1).map((v) => v.toLowerCase());
    if (values.length === 0) return false;
    if (values.includes("*")) return true;
    // Host expressions are left as a "no". Matching a CSP source list properly
    // — schemes, ports, wildcards in host position — is not something to
    // reimplement from memory when guessing wrong means framing a site that
    // said no.
    return sameOrigin && values.includes("'self'");
  }
  return true;
}

export function xfoAllowsFraming(xfo: string | null, sameOrigin = false): boolean {
  if (!xfo) return true;
  const v = xfo.trim().toLowerCase();
  if (v.includes("deny")) return false;
  // The only value whose answer depends on who is asking.
  if (v.includes("sameorigin")) return sameOrigin;
  // Obsolete and unsupported by Chrome, which treats it as no policy at all —
  // but a site that sent it meant to restrict, so it is read as a refusal.
  if (v.includes("allow-from")) return false;
  return true;
}

// ------------------------------------------------------------- network layer

/**
 * `pageOrigin` is the origin of the tab the gesture was made on, and it only
 * affects `nativelyFramable`: it is what lets `SAMEORIGIN` and
 * `frame-ancestors 'self'` read as a yes when they actually are one. Omitted,
 * every answer is the cross-origin answer.
 */
export async function inspectTarget(
  targetUrl: string,
  budgetMs: number,
  pageOrigin?: string | null,
): Promise<TargetInfo | null> {
  const { signal, cancel } = deadline(budgetMs);
  try {
    const res = await fetch(targetUrl, {
      method: "GET",
      redirect: "follow",
      credentials: "omit",
      signal,
    });

    const xfo = res.headers.get("x-frame-options");
    const csp = res.headers.get("content-security-policy");

    const bytes = await readCapped(res, HTML_BYTE_LIMIT);
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const finalUrl = res.url || targetUrl;
    const meta = extractPreview(html, finalUrl);
    // The FINAL url, after redirects: a link that leaves the origin on the way
    // is not same-origin, whatever the href said.
    const same = isSameOrigin(finalUrl, pageOrigin);

    return {
      finalUrl,
      // The DNR rule removes exactly the two headers checked below, so a
      // reachable page is a framable one. It is still only a strong guess: a
      // page's own frame-busting script is not a header, and a site served from
      // its own service worker never hits the network for the rule to apply —
      // which is why the 400ms iframe load timeout in departure.ts is mandatory.
      framable: res.ok,
      nativelyFramable:
        res.ok && xfoAllowsFraming(xfo, same) && cspAllowsFraming(csp, same),
      ...meta,
    };
  } catch {
    return null;
  } finally {
    cancel();
  }
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  // §7.4: btoa in one shot blows the argument limit on anything sizeable.
  let bin = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

async function fetchImageAsDataUrl(
  url: string,
  budgetMs: number,
): Promise<string | null> {
  // `extractPreview` no longer resolves data: URLs, so nothing should reach
  // here with one. Refuse rather than trust that.
  if (url.startsWith("data:")) return null;
  const { signal, cancel } = deadline(budgetMs);
  try {
    const res = await fetch(url, { redirect: "follow", credentials: "omit", signal });
    if (!res.ok) return null;

    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (type && !type.startsWith("image/")) return null;

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > IMAGE_BYTE_LIMIT) return null;

    const bytes = await readCapped(res, IMAGE_BYTE_LIMIT + 1);
    if (bytes.byteLength > IMAGE_BYTE_LIMIT) return null;
    if (bytes.byteLength === 0) return null;

    return bytesToDataUrl(bytes, type || "image/jpeg");
  } catch {
    return null;
  } finally {
    cancel();
  }
}

/**
 * §8 mode C fallback: Chrome's own favicon service. Fetched here (rather than
 * referenced from the page) so the content script receives a same-origin
 * `data:` URL and needs no web_accessible_resources entry or CSP exemption.
 */
export async function faviconDataUrl(
  targetUrl: string,
  size = 64,
): Promise<string | null> {
  try {
    const url = `${chrome.runtime.getURL("_favicon/")}?pageUrl=${encodeURIComponent(
      targetUrl,
    )}&size=${size}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.byteLength) return null;
    return bytesToDataUrl(
      bytes,
      (res.headers.get("content-type") ?? "image/png").split(";")[0]!.trim(),
    );
  } catch {
    return null;
  }
}

/**
 * The whole mode-C pipeline under one budget. Always resolves — a portal with a
 * favicon in it is fine; an empty portal is not.
 */
export async function buildVision(
  targetUrl: string,
  info: TargetInfo | null,
  budgetMs: number,
): Promise<Vision> {
  const themeColor = info?.themeColor ?? DEFAULT_THEME_COLOR;

  let imageDataUrl: string | null = null;
  let imageKind: Vision["imageKind"] = null;

  if (info?.imageUrl) {
    imageDataUrl = await fetchImageAsDataUrl(info.imageUrl, budgetMs);
    if (imageDataUrl) imageKind = "og";
  }
  if (!imageDataUrl) {
    // A larger favicon than the old 64: it is about to be the centrepiece of a
    // composed card rather than a texture stretched over the whole disc.
    imageDataUrl = await faviconDataUrl(targetUrl, 128);
    if (imageDataUrl) imageKind = "favicon";
  }

  return {
    imageDataUrl,
    imageKind,
    themeColor,
    title: info?.title ?? null,
    description: info?.description ?? null,
    siteName: info?.siteName ?? null,
  };
}