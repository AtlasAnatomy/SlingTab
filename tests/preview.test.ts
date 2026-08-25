import { describe, expect, it } from "vitest";
import {
  bytesToDataUrl,
  cspAllowsFraming,
  extractPreview,
  inspectTarget,
  isSameOrigin,
  normaliseColor,
  xfoAllowsFraming,
} from "../src/background/preview";
import { parseColor } from "../src/content/renderer/types";

const BASE = "https://example.com/articles/one";

describe("extractPreview", () => {
  it("prefers og:image", () => {
    const html = `
      <meta name="twitter:image" content="/tw.png">
      <meta property="og:image" content="https://cdn.example.com/og.jpg">
      <link rel="apple-touch-icon" href="/touch.png">`;
    expect(extractPreview(html, BASE).imageUrl).toBe("https://cdn.example.com/og.jpg");
  });

  it("falls back to twitter:image, then apple-touch-icon", () => {
    const tw = `<meta name="twitter:image" content="/tw.png">
                <link rel="apple-touch-icon" href="/touch.png">`;
    expect(extractPreview(tw, BASE).imageUrl).toBe("https://example.com/tw.png");

    const icon = `<link rel="apple-touch-icon" sizes="76x76" href="/small.png">
                  <link rel="apple-touch-icon" sizes="180x180" href="/big.png">`;
    // Largest declared size wins.
    expect(extractPreview(icon, BASE).imageUrl).toBe("https://example.com/big.png");
  });

  it("resolves relative URLs against the final response URL", () => {
    const html = `<meta property="og:image" content="../img/hero.png">`;
    expect(extractPreview(html, BASE).imageUrl).toBe("https://example.com/img/hero.png");
  });

  it("decodes entities in attribute values", () => {
    const html = `<meta property="og:image" content="/i.png?a=1&amp;b=2">`;
    expect(extractPreview(html, BASE).imageUrl).toBe("https://example.com/i.png?a=1&b=2");
  });

  it("handles single quotes and unquoted attributes", () => {
    expect(extractPreview(`<meta property='og:image' content='/a.png'>`, BASE).imageUrl)
      .toBe("https://example.com/a.png");
    expect(extractPreview(`<meta property=og:image content=/b.png>`, BASE).imageUrl)
      .toBe("https://example.com/b.png");
  });

  it("rejects non-http image schemes", () => {
    for (const bad of [
      "javascript:alert(1)",
      // A data: og:image would hand an arbitrary blob to createImageBitmap in
      // the content script, chosen by whoever wrote the page we are on.
      "data:image/svg+xml,<svg onload=alert(1)>",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
    ]) {
      const html = `<meta property="og:image" content="${bad}">`;
      expect(extractPreview(html, BASE).imageUrl, bad).toBeNull();
    }
  });

  it("extracts theme-color and defaults when absent", () => {
    expect(extractPreview(`<meta name="theme-color" content="#1a73e8">`, BASE).themeColor)
      .toBe("#1a73e8");
    expect(extractPreview("<html></html>", BASE).themeColor).toBe("#0b0a09");
  });

  it("survives truncation mid-tag (we only read 64KB)", () => {
    const html = `<meta property="og:image" content="/ok.png"><meta property="og:desc`;
    expect(extractPreview(html, BASE).imageUrl).toBe("https://example.com/ok.png");
  });

  it("returns nothing rather than throwing on garbage", () => {
    expect(extractPreview("<<<>>> not html", BASE).imageUrl).toBeNull();
    expect(extractPreview("", BASE).imageUrl).toBeNull();
  });
});

describe("extractPreview text", () => {
  it("prefers og:title, then twitter:title, then the <title> tag", () => {
    const og = `<meta property="og:title" content="OG"><meta name="twitter:title" content="TW"><title>Tag</title>`;
    expect(extractPreview(og, BASE).title).toBe("OG");

    const tw = `<meta name="twitter:title" content="TW"><title>Tag</title>`;
    expect(extractPreview(tw, BASE).title).toBe("TW");

    expect(extractPreview(`<title>Tag</title>`, BASE).title).toBe("Tag");
    expect(extractPreview(`<html></html>`, BASE).title).toBeNull();
  });

  it("reads a <title> carrying attributes", () => {
    expect(extractPreview(`<title data-x="1">Hello</title>`, BASE).title).toBe("Hello");
  });

  it("collapses whitespace and decodes entities", () => {
    const html = `<title>\n  Ben &amp; Jerry&#39;s\t\n</title>`;
    expect(extractPreview(html, BASE).title).toBe("Ben & Jerry's");
  });

  it("truncates rather than shipping a whole paragraph across the message boundary", () => {
    const long = "word ".repeat(200);
    const t = extractPreview(`<title>${long}</title>`, BASE).title!;
    expect(t.length).toBeLessThanOrEqual(90);
    expect(t.endsWith("…")).toBe(true);

    const d = extractPreview(
      `<meta name="description" content="${long}">`,
      BASE,
    ).description!;
    expect(d.length).toBeLessThanOrEqual(160);
  });

  it("picks up description and site name", () => {
    const html = `
      <meta property="og:description" content="A description.">
      <meta property="og:site_name" content="Example">`;
    const m = extractPreview(html, BASE);
    expect(m.description).toBe("A description.");
    expect(m.siteName).toBe("Example");
  });

  it("treats an empty or whitespace-only value as absent", () => {
    const html = `<meta property="og:title" content="   "><title>   </title>`;
    expect(extractPreview(html, BASE).title).toBeNull();
  });
});

describe("normaliseColor", () => {
  it("accepts hex, rgb() and bare names", () => {
    expect(normaliseColor("#fff")).toBe("#fff");
    expect(normaliseColor("  #1A73E8 ")).toBe("#1a73e8");
    expect(normaliseColor("rgb(10, 20, 30)")).toBe("rgb(10, 20, 30)");
    expect(normaliseColor("black")).toBe("black");
  });

  it("takes the head of a media-qualified value", () => {
    expect(normaliseColor("#111; media=(prefers-color-scheme: dark)")).toBe("#111");
  });

  it("rejects junk", () => {
    expect(normaliseColor("url(evil)")).toBeNull();
    expect(normaliseColor("")).toBeNull();
    expect(normaliseColor(null)).toBeNull();
  });
});

describe("framability probe", () => {
  it("x-frame-options", () => {
    expect(xfoAllowsFraming(null)).toBe(true);
    expect(xfoAllowsFraming("DENY")).toBe(false);
    expect(xfoAllowsFraming("sameorigin")).toBe(false);
    expect(xfoAllowsFraming("ALLOW-FROM https://a.com")).toBe(false);
  });

  it("csp frame-ancestors", () => {
    expect(cspAllowsFraming(null)).toBe(true);
    expect(cspAllowsFraming("default-src 'self'")).toBe(true);
    expect(cspAllowsFraming("frame-ancestors *")).toBe(true);
    expect(cspAllowsFraming("frame-ancestors 'self'")).toBe(false);
    expect(cspAllowsFraming("frame-ancestors 'none'")).toBe(false);
    expect(cspAllowsFraming("default-src 'self'; frame-ancestors https://a.com")).toBe(false);
    // An empty frame-ancestors list allows nothing.
    expect(cspAllowsFraming("script-src 'self'; frame-ancestors")).toBe(false);
  });

  /**
   * `SAMEORIGIN` and `frame-ancestors 'self'` are the two values whose answer
   * depends on who is asking, and reading them as a flat "no" is what used to
   * send every same-origin link down mode A — stripping a site's own CSP to
   * build a frame that site was already willing to grant.
   */
  it("reads 'self' as a yes only for a same-origin framer", () => {
    expect(xfoAllowsFraming("SAMEORIGIN", true)).toBe(true);
    expect(xfoAllowsFraming("SAMEORIGIN", false)).toBe(false);
    expect(cspAllowsFraming("frame-ancestors 'self'", true)).toBe(true);
    expect(cspAllowsFraming("frame-ancestors 'self'", false)).toBe(false);
    expect(cspAllowsFraming("default-src 'self'; frame-ancestors 'self' https://a.com", true))
      .toBe(true);
  });

  it("keeps refusing outright, same origin or not", () => {
    expect(xfoAllowsFraming("DENY", true)).toBe(false);
    expect(xfoAllowsFraming("ALLOW-FROM https://a.com", true)).toBe(false);
    expect(cspAllowsFraming("frame-ancestors 'none'", true)).toBe(false);
    expect(cspAllowsFraming("script-src 'self'; frame-ancestors", true)).toBe(false);
    // A host expression stays a "no": matching a CSP source list is not
    // reimplemented here, and guessing wrong means framing a site that said no.
    expect(cspAllowsFraming("frame-ancestors https://a.com", true)).toBe(false);
  });
});

describe("isSameOrigin", () => {
  it("compares origins, not urls", () => {
    expect(isSameOrigin("https://a.com/x?q=1#f", "https://a.com")).toBe(true);
    expect(isSameOrigin("https://a.com/x", "https://b.com")).toBe(false);
    // Scheme and port are part of an origin.
    expect(isSameOrigin("http://a.com/x", "https://a.com")).toBe(false);
    expect(isSameOrigin("https://a.com:8443/x", "https://a.com")).toBe(false);
  });

  it("answers no for anything it cannot compare", () => {
    // The worker must degrade to the cross-origin answer — the one that strips
    // nothing on its own — rather than guess.
    expect(isSameOrigin("https://a.com/x", null)).toBe(false);
    expect(isSameOrigin("https://a.com/x", undefined)).toBe(false);
    expect(isSameOrigin("https://a.com/x", "")).toBe(false);
    expect(isSameOrigin("not a url", "https://a.com")).toBe(false);
  });
});

describe("inspectTarget framability", () => {
  /**
   * `framable` and `nativelyFramable` used to be assigned the same expression,
   * which made mode A dead code: the header-stripping path could only engage for
   * sites that were already framable — exactly the ones livePreview had handled
   * one branch earlier. Stripping is the entire point of mode A, so the two must
   * disagree precisely when a site refuses.
   */
  const probe = async (headers: Record<string, string>, pageOrigin?: string) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html><title>T</title></html>", { headers })) as typeof fetch;
    try {
      return await inspectTarget("https://example.com/", 1000, pageOrigin);
    } finally {
      globalThis.fetch = original;
    }
  };

  it("reports a site with no framing headers as framable both ways", async () => {
    const info = await probe({});
    expect(info?.nativelyFramable).toBe(true);
    expect(info?.framable).toBe(true);
  });

  it("reports a refusing site as strippable but not natively framable", async () => {
    const cases: Record<string, string>[] = [
      { "x-frame-options": "DENY" },
      { "x-frame-options": "SAMEORIGIN" },
      { "content-security-policy": "frame-ancestors 'self'" },
    ];
    for (const headers of cases) {
      const info = await probe(headers);
      expect(info?.nativelyFramable, JSON.stringify(headers)).toBe(false);
      // The DNR rule removes exactly these headers, so mode A can still frame it.
      expect(info?.framable, JSON.stringify(headers)).toBe(true);
    }
  });

  it("still carries the extracted metadata alongside", async () => {
    const info = await probe({ "x-frame-options": "DENY" });
    expect(info?.title).toBe("T");
  });

  /**
   * The whole point of threading the page's origin through: a link to a sibling
   * page on the site you are already reading needs no header stripped, so
   * handleDepart can decline mode A for it and still show the live page.
   */
  it("reports a same-origin destination as natively framable", async () => {
    const cases: Record<string, string>[] = [
      { "x-frame-options": "SAMEORIGIN" },
      { "content-security-policy": "frame-ancestors 'self'" },
    ];
    for (const headers of cases) {
      const info = await probe(headers, "https://example.com");
      expect(info?.nativelyFramable, JSON.stringify(headers)).toBe(true);
    }
  });

  it("does not soften a same-origin destination that refuses outright", async () => {
    const info = await probe({ "x-frame-options": "DENY" }, "https://example.com");
    expect(info?.nativelyFramable).toBe(false);
  });

  it("is unchanged when no page origin is supplied", async () => {
    const info = await probe({ "x-frame-options": "SAMEORIGIN" });
    expect(info?.nativelyFramable).toBe(false);
  });
});

describe("bytesToDataUrl", () => {
  it("round-trips through base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 65, 66]);
    const url = bytesToDataUrl(bytes, "image/png");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const back = Uint8Array.from(atob(url.split(",")[1]!), (c) => c.charCodeAt(0));
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it("handles payloads larger than the 8192-byte chunk", () => {
    // The whole point of chunking: String.fromCharCode(...big) blows the
    // argument limit and throws RangeError.
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const url = bytesToDataUrl(bytes, "image/jpeg");
    const back = Uint8Array.from(atob(url.split(",")[1]!), (c) => c.charCodeAt(0));
    expect(back.length).toBe(bytes.length);
    expect(back[199_999]).toBe(bytes[199_999]);
  });
});

describe("parseColor", () => {
  it("parses hex forms", () => {
    expect(parseColor("#fff")).toEqual([1, 1, 1]);
    expect(parseColor("#000000")).toEqual([0, 0, 0]);
    const [r, g, b] = parseColor("#ff8a1f");
    expect(r).toBeCloseTo(1, 2);
    expect(g).toBeCloseTo(0.541, 2);
    expect(b).toBeCloseTo(0.121, 2);
  });

  it("parses rgb()/rgba() and falls back on junk", () => {
    expect(parseColor("rgb(255, 0, 0)")).toEqual([1, 0, 0]);
    expect(parseColor("rgba(0, 255, 0, 0.5)")).toEqual([0, 1, 0]);
    expect(parseColor("nonsense")).toEqual([0.043, 0.039, 0.035]);
    expect(parseColor(null)).toEqual([0.043, 0.039, 0.035]);
  });
});