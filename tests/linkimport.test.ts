import { describe, expect, it } from "vitest";
import { hostLabel, normaliseUrl, parseLine, parseLinkList } from "../src/shared/linkimport";

/**
 * The pasted-list parser. Every failure mode here is silent and ugly — eight
 * links all labelled "https", a header line imported as a link, a name losing
 * half its words — so the shapes are pinned rather than the implementation.
 */

const MAX = 8;
const urls = (t: string) => parseLinkList(t, MAX).links.map((l) => l.url);
const labels = (t: string) => parseLinkList(t, MAX).links.map((l) => l.label);

describe("normaliseUrl", () => {
  it("accepts http and https", () => {
    expect(normaliseUrl("https://a.com/x")).toBe("https://a.com/x");
    expect(normaliseUrl("http://a.com/")).toBe("http://a.com/");
  });

  it("prefixes a bare hostname with https", () => {
    expect(normaliseUrl("example.com")).toBe("https://example.com/");
    expect(normaliseUrl("docs.rs/regex")).toBe("https://docs.rs/regex");
  });

  it("rejects every other scheme", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "chrome://settings",
      "chrome-extension://abc/x.html",
      "vbscript:msgbox",
    ]) {
      expect(normaliseUrl(bad), bad).toBeNull();
    }
  });

  it("rejects an address with whitespace inside it", () => {
    // `new URL` percent-encodes an interior space instead of failing, so
    // "https://site/Page Wikipedia" would parse as one address ending in
    // "%20Wikipedia" — swallowing the name and yielding a link that 404s.
    expect(normaliseUrl("https://site/Page Wikipedia")).toBeNull();
  });

  it("rejects things that merely contain a dot", () => {
    for (const bad of ["3,50", "v1.2", "", "   ", "a."]) {
      expect(normaliseUrl(bad), bad).toBeNull();
    }
  });

  it("strips angle brackets from a pasted address", () => {
    expect(normaliseUrl("<https://a.com/>")).toBe("https://a.com/");
  });
});

describe("hostLabel", () => {
  it("drops the www", () => {
    expect(hostLabel("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
    expect(hostLabel("not a url")).toBe("");
  });
});

describe("parseLine", () => {
  it("reads `address name`", () => {
    expect(parseLine("https://news.ycombinator.com Hacker News")).toEqual({
      url: "https://news.ycombinator.com/",
      label: "Hacker News",
    });
  });

  it("reads `name address` too, because both orders are natural", () => {
    expect(parseLine("Hacker News https://news.ycombinator.com")?.label).toBe("Hacker News");
  });

  it("keeps the spaces in a multi-word name", () => {
    expect(parseLine("https://a.com The Long Name Of It")?.label).toBe("The Long Name Of It");
  });

  it("falls back to the hostname when there is no name", () => {
    expect(parseLine("https://news.ycombinator.com")?.label).toBe("news.ycombinator.com");
  });

  it("returns null for a line with no address", () => {
    expect(parseLine("just some words")).toBeNull();
    expect(parseLine("   ")).toBeNull();
  });

  it("truncates a very long name instead of storing it", () => {
    const line = `https://a.com ${"x".repeat(200)}`;
    expect(parseLine(line)!.label.length).toBeLessThanOrEqual(32);
  });
});

describe("parseLinkList", () => {
  it("reads the exact shape from the report", () => {
    const t = "https://it.wikipedia.org/wiki/Pagina_principale wikipedia";
    expect(parseLinkList(t, MAX).links).toEqual([
      { url: "https://it.wikipedia.org/wiki/Pagina_principale", label: "wikipedia" },
    ]);
  });

  it("reads a whole list", () => {
    const t = [
      "https://news.ycombinator.com Hacker News",
      "https://developer.mozilla.org MDN",
      "https://it.wikipedia.org Wikipedia",
    ].join("\n");
    expect(urls(t)).toHaveLength(3);
    expect(labels(t)).toEqual(["Hacker News", "MDN", "Wikipedia"]);
  });

  it("accepts a tab as the separator, so a spreadsheet paste still lands", () => {
    // Not CSV support: a tab is simply whitespace, which is all this splits on.
    expect(labels("https://a.com\tAlpha\nhttps://b.com\tBravo")).toEqual(["Alpha", "Bravo"]);
  });

  it("counts lines it could not use rather than failing the whole paste", () => {
    const r = parseLinkList("https://a.com Docs\nnot a link at all\n\nalso bad", MAX);
    expect(r.links).toHaveLength(1);
    expect(r.skipped).toBe(2);
  });

  it("deduplicates without spending a slot", () => {
    const r = parseLinkList("https://a.com A\nhttps://a.com B\nhttps://b.com C", MAX);
    expect(r.links.map((l) => l.url)).toEqual(["https://a.com/", "https://b.com/"]);
    expect(r.overflow).toBe(0);
  });

  it("caps at max and reports the overflow", () => {
    const t = Array.from({ length: 11 }, (_, i) => `https://s${i}.com S${i}`).join("\n");
    const r = parseLinkList(t, MAX);
    expect(r.links).toHaveLength(MAX);
    expect(r.overflow).toBe(3);
  });

  it("never imports a non-http scheme, whichever end it is on", () => {
    const r = parseLinkList(
      "javascript:alert(1) Evil\nAlso evil data:text/html,x\nhttps://a.com Ok",
      MAX,
    );
    expect(r.links.map((l) => l.url)).toEqual(["https://a.com/"]);
  });

  it("strips a BOM and tolerates CRLF", () => {
    expect(urls("﻿https://a.com Docs\r\nhttps://b.com News\r\n")).toHaveLength(2);
  });

  it("returns an empty result for empty input", () => {
    expect(parseLinkList("", MAX)).toEqual({ links: [], skipped: 0, overflow: 0 });
    expect(parseLinkList("   \n\n  ", MAX).links).toHaveLength(0);
  });
});
