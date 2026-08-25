/**
 * Session-scoped header rules for mode A, with guaranteed teardown.
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
 * Strip X-Frame-Options / CSP from sub-frame responses for `targetUrl`, in this
 * tab only. Returns false if the rule could not be installed — the caller must
 * then fall back to mode C rather than mounting an iframe that will be blocked.
 */
export async function armFrameRule(tabId: number, targetUrl: string): Promise<boolean> {
  await releaseFrameRule(tabId);

  let host: string;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return false;
  }
  if (!host) return false;

  const id = allocId();
  try {
    await applyRules(
      [
        {
          id,
          priority: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            responseHeaders: [
              {
                header: "x-frame-options",
                operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
              },
              {
                header: "content-security-policy",
                operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
              },
              {
                header: "content-security-policy-report-only",
                operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
              },
            ],
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