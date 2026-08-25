/**
 * Session-scoped header rules for mode A, with guaranteed teardown.
 *
 * How much each rule removes depends on whether the destination is cross-origin
 * or same-origin with the page the gesture was made on — see FrameRuleScope.
 *
 * Rules:
 *  - `updateSessionRules`, NEVER `updateDynamicRules`. Dynamic rules persist
 *    across browser restarts; a stale header-stripping rule that outlives the
 *    gesture that created it is a real security liability.
 *  - `condition.tabIds` is only valid on session-scoped rules — which is the
 *    other reason session rules are the right tool here.
 *  - Every rule is released in a `finally` on navigation commit AND by a 5s
 *    watchdog. A leaked rule is the highest-severity bug in this codebase.
 */

const RULE_ID_MIN = 9000;
const RULE_ID_MAX = 9899;
const WATCHDOG_MS = 5000;

/**
 * How much of the destination's framing policy the rule removes.
 *
 * "all"  X-Frame-Options AND Content-Security-Policy, for a CROSS-ORIGIN
 *        destination. `frame-ancestors` lives in the CSP and DNR can drop a
 *        header but not edit one, so refusing sites cannot be framed without
 *        taking the whole header — `script-src` included. What makes that
 *        tolerable is the frame being cross-site: `SameSite=Lax` withholds the
 *        session cookies, so the preview is of a logged-out page.
 *
 * "xfo"  X-Frame-Options ONLY, for a SAME-ORIGIN destination — where that
 *        argument does not hold, because a same-site frame does carry the
 *        user's cookies. Removing the CSP there would strip `script-src` from
 *        an authenticated document, so it is left alone.
 *
 *        Almost nothing is given up. The values that actually block
 *        same-origin framing are `X-Frame-Options: DENY` and
 *        `frame-ancestors 'none'`; `SAMEORIGIN` and `frame-ancestors 'self'`
 *        — which is nearly every site that sets anything — already permit it,
 *        and need no rule at all. So dropping XFO covers DENY and the CSP
 *        never has to be touched. A page that really does send
 *        `frame-ancestors 'none'` does not frame, and falls back to the card.
 */
export type FrameRuleScope = "all" | "xfo";

interface ActiveRule {
  id: number;
  timer: ReturnType<typeof setTimeout>;
}

const active = new Map<number, ActiveRule>();
let nextId = RULE_ID_MIN;

function allocId(): number {
  const id = nextId;
  nextId = nextId >= RULE_ID_MAX ? RULE_ID_MIN : nextId + 1;
  return id;
}

async function applyRules(
  addRules: chrome.declarativeNetRequest.Rule[],
  removeRuleIds: number[],
): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({ addRules, removeRuleIds });
}

/**
 * Strip framing headers from sub-frame responses for `targetUrl`, in this tab
 * only. `scope` decides how much comes off; see FrameRuleScope. Returns false
 * if the rule could not be installed — the caller must then fall back to mode C
 * rather than mounting an iframe that will be blocked.
 */
export async function armFrameRule(
  tabId: number,
  targetUrl: string,
  scope: FrameRuleScope = "all",
): Promise<boolean> {
  await releaseFrameRule(tabId);

  let host: string;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return false;
  }
  if (!host) return false;

  const remove = (header: string) => ({
    header,
    operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
  });
  const responseHeaders =
    scope === "xfo"
      ? [remove("x-frame-options")]
      : [
          remove("x-frame-options"),
          remove("content-security-policy"),
          remove("content-security-policy-report-only"),
        ];

  const id = allocId();
  try {
    await applyRules(
      [
        {
          id,
          priority: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            responseHeaders,
          },
          condition: {
            urlFilter: `||${host}^`,
            resourceTypes: [chrome.declarativeNetRequest.ResourceType.SUB_FRAME],
            tabIds: [tabId],
          },
        },
      ],
      [id],
    );
  } catch {
    return false;
  }

  const timer = setTimeout(() => {
    void releaseFrameRule(tabId);
  }, WATCHDOG_MS);

  active.set(tabId, { id, timer });
  return true;
}

export async function releaseFrameRule(tabId: number): Promise<void> {
  const rec = active.get(tabId);
  if (!rec) return;
  active.delete(tabId);
  clearTimeout(rec.timer);
  try {
    await applyRules([], [rec.id]);
  } catch {
    // If the targeted removal failed, fall back to nuking everything we own.
    await sweepAllRules();
  }
}

/**
 * Remove every session rule in our id range. Called on SW startup/install: a
 * worker killed mid-portal leaves the rule behind (session rules outlive the
 * worker, they only die with the browser session).
 */
export async function sweepAllRules(): Promise<void> {
  for (const rec of active.values()) clearTimeout(rec.timer);
  active.clear();
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ids = rules
      .map((r) => r.id)
      .filter((id) => id >= RULE_ID_MIN && id <= RULE_ID_MAX);
    if (ids.length) await applyRules([], ids);
  } catch {
    /* nothing we can do */
  }
}

/** For the acceptance matrix: should be [] after any number of gestures. */
export async function listOwnRules(): Promise<number[]> {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return rules.map((r) => r.id).filter((id) => id >= RULE_ID_MIN && id <= RULE_ID_MAX);
  } catch {
    return [];
  }
}