import { beforeEach, describe, expect, it, vi } from "vitest";
import { armFrameRule, releaseFrameRule, sweepAllRules } from "../src/background/dnr";

/**
 * What mode A actually takes off the wire.
 *
 * This exists because the answer was changed twice in one sitting and the
 * second change was a regression nobody would have caught from a type error.
 * Declining to arm the rule for a same-origin destination — on the reasoning
 * that same-origin framing is already permitted — quietly cost the live
 * preview on a large share of real links, because it pushed them onto a probe
 * that says no for anything not answering a credential-less GET with a 200:
 * a page behind a login, a bot-protection interstitial, a slow host. Mode A
 * works precisely because it never asks.
 *
 * So the rule is always armed. The only thing that varies is how much it
 * removes, and that is what is pinned here.
 */

let added: chrome.declarativeNetRequest.Rule[] = [];

const headersOf = (rule: chrome.declarativeNetRequest.Rule): string[] =>
  (rule.action.responseHeaders ?? []).map((h) => h.header);

beforeEach(async () => {
  added = [];
  vi.stubGlobal("chrome", {
    declarativeNetRequest: {
      RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
      HeaderOperation: { REMOVE: "remove" },
      ResourceType: { SUB_FRAME: "sub_frame" },
      updateSessionRules: async (o: { addRules?: chrome.declarativeNetRequest.Rule[] }) => {
        for (const r of o.addRules ?? []) added.push(r);
      },
      getSessionRules: async () => [],
    },
  });
  // The module keeps a tab -> rule map across tests.
  await sweepAllRules();
});

describe("armFrameRule", () => {
  it("takes X-Frame-Options AND the CSP for a cross-origin destination", async () => {
    expect(await armFrameRule(7, "https://other.com/page", "all")).toBe(true);
    expect(headersOf(added[0]!)).toEqual([
      "x-frame-options",
      "content-security-policy",
      "content-security-policy-report-only",
    ]);
  });

  it("defaults to the cross-origin scope", async () => {
    await armFrameRule(7, "https://other.com/page");
    expect(headersOf(added[0]!)).toContain("content-security-policy");
  });

  /**
   * The security half of the fix. A same-site frame DOES carry the user's
   * cookies — `SameSite=Lax` only withholds them cross-site — so removing the
   * CSP there would strip `script-src` from an authenticated document.
   */
  it("leaves the CSP alone for a same-origin destination", async () => {
    expect(await armFrameRule(7, "https://site.com/b", "xfo")).toBe(true);
    expect(headersOf(added[0]!)).toEqual(["x-frame-options"]);
  });

  it("arms whatever the scope, so the preview never depends on a probe", async () => {
    for (const scope of ["all", "xfo"] as const) {
      added = [];
      await releaseFrameRule(7);
      expect(await armFrameRule(7, "https://site.com/b", scope), scope).toBe(true);
      expect(added, scope).toHaveLength(1);
    }
  });

  it("stays sub-frame and tab scoped in both scopes", async () => {
    for (const scope of ["all", "xfo"] as const) {
      added = [];
      await releaseFrameRule(7);
      await armFrameRule(7, "https://site.com/b", scope);
      expect(added[0]!.condition.resourceTypes, scope).toEqual(["sub_frame"]);
      expect(added[0]!.condition.tabIds, scope).toEqual([7]);
      expect(added[0]!.condition.urlFilter, scope).toBe("||site.com^");
    }
  });

  it("refuses a url with no hostname rather than arming something broad", async () => {
    expect(await armFrameRule(7, "not a url")).toBe(false);
    expect(added).toHaveLength(0);
  });
});
