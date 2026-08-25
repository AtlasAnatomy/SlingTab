/**
 * Quick links from a pasted list.
 *
 * One link per line, address and name separated by whitespace:
 *
 *     https://news.ycombinator.com Hacker News
 *     https://it.wikipedia.org/wiki/Pagina_principale Wikipedia
 *
 * The name may contain spaces; only the address may not. Either order works,
 * because "name first" and "address first" are both natural and guessing wrong
 * silently produces a list of links all called `https`.
 *
 * There is no CSV here on purpose. Delimiter sniffing, quoted fields and header
 * detection were three hundred lines to support a format nobody was going to
 * paste by hand, and a tab is whitespace, so a spreadsheet paste still lands
 * correctly without any of it.
 *
 * Pure and DOM-free; `tests/linkimport.test.ts` covers it.
 */

/** Longest name we keep; `settings.coerce` truncates to the same length. */
const LABEL_LIMIT = 32;

/**
 * A bare hostname, optionally with a path: `example.com`, `docs.rs/regex`.
 * Requires a dot and an alphabetic TLD, so "3,50" and "v1.2" are not mistaken
 * for addresses.
 */
const BARE_HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?:[/?#][^\s]*)?$/i;

export interface ImportedLink {
  url: string;
  label: string;
}

export interface ImportResult {
  links: ImportedLink[];
  /** Lines that held something but no usable http(s) address. */
  skipped: number;
  /** Valid links found beyond `max`, so the UI can say what it dropped. */
  overflow: number;
}

export const EMPTY_IMPORT: ImportResult = { links: [], skipped: 0, overflow: 0 };

/** `example.com` -> `https://example.com`; anything not http(s) -> null. */
export function normaliseUrl(raw: string): string | null {
  const s = raw.trim().replace(/^<|>$/g, "");
  if (!s) return null;

  // Reject anything with whitespace inside it BEFORE handing it to `new URL`.
  // The URL parser silently percent-encodes an interior space, so
  // "https://site/Page Wikipedia" parses happily as one address ending in
  // "%20Wikipedia" — swallowing the name and producing a link that 404s.
  if (/\s/.test(s)) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(s)
    ? s
    : BARE_HOST.test(s)
      ? `https://${s}`
      : null;
  if (!candidate) return null;

  try {
    const u = new URL(candidate);
    // Everything else — javascript:, data:, file:, chrome: — is rejected here
    // rather than downstream, so no caller has to remember to check.
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function cleanLabel(raw: string): string {
  // Control characters survive a copy out of some apps and render as boxes.
  // eslint-disable-next-line no-control-regex
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LABEL_LIMIT);
}

/** One line -> one link, or null if it holds no address. */
export function parseLine(line: string): ImportedLink | null {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  // Only the two ends are considered. An address buried mid-line is far more
  // likely to be a URL quoted inside a title than the line's actual target.
  for (const i of tokens.length === 1 ? [0] : [0, tokens.length - 1]) {
    const url = normaliseUrl(tokens[i]!);
    if (!url) continue;
    const label = cleanLabel(tokens.filter((_, k) => k !== i).join(" "));
    return { url, label: label || hostLabel(url) };
  }
  return null;
}

export function parseLinkList(text: string, max: number): ImportResult {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const links: ImportedLink[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let overflow = 0;

  for (const line of lines) {
    const hit = parseLine(line);
    if (!hit) {
      skipped++;
      continue;
    }
    // A duplicate is not an import and must not spend one of the slots.
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);

    if (links.length >= max) {
      overflow++;
      continue;
    }
    links.push(hit);
  }

  return { links, skipped, overflow };
}
