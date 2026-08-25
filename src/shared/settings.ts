export type TriggerMode = "right" | "alt" | "hand";

/** Re-exported so callers do not have to reach into the tracker module. */
export type HandPose = "any" | "twoFingers";

export interface QuickLink {
  url: string;
  label: string;
}

export interface Settings {
  /**
   * Storage schema version. Not a user setting — it exists so a default that
   * changes meaning can reach people who already have a value stored.
   */
  schema: number;
  enabled: boolean;
  trigger: TriggerMode;
  /**
   * Mode A: frame the destination even when it refuses, by stripping
   * X-Frame-Options and CSP for that one sub-frame request, in that one tab,
   * for the second or two the portal is open.
   *
   * On by default. It is what makes the disc show the real page for the sites
   * people actually visit — almost all of which refuse framing, so `livePreview`
   * alone falls back to a logo. The trade is that clickjacking protection is
   * removed for the framed request, and the mitigation is that the frame is
   * inert: `pointer-events: none`, no forms, no popups, no top navigation. An
   * iframe nobody can click is not a clickjacking surface.
   *
   * Turn it off to keep every site's headers untouched and accept a composed
   * card in the disc instead.
   */
  iframeMode: boolean;
  /**
   * Frame the destination when it already allows framing, with NO header
   * stripping and no DNR rule. Nothing is weakened, so this is on by default —
   * it is what makes the portal show the real page instead of a logo.
   * Framed sites still appear logged out (SameSite=Lax, §7.9).
   */
  livePreview: boolean;
  quickLinks: QuickLink[];
  /** Set once the user has been shown the first-run quick-link prompt. */
  onboarded: boolean;
  /** Log why a gesture did or did not fire, to the page console. */
  debug: boolean;
  /**
   * Hand trigger only. "twoFingers" requires index and middle raised with ring
   * and pinky folded before a circle counts; "any" accepts any hand shape.
   */
  handPose: HandPose;
}

/**
 * Bump this whenever an existing field's default flips, and handle the old
 * version in `coerce`.
 *
 *  1 → 2  `iframeMode` went from off to on. The stored `false` most people
 *         carried was a decision about a feature that never actually worked:
 *         `inspectTarget` reported the same value for "framable" and "framable
 *         without stripping", so mode A could only ever engage for sites the
 *         other branch had already handled. Turning it on changed nothing, so
 *         leaving it off preserves no real choice — it just keeps the portal
 *         showing a card forever.
 */
export const SETTINGS_SCHEMA = 2;

export const DEFAULT_SETTINGS: Settings = {
  schema: SETTINGS_SCHEMA,
  enabled: true,
  trigger: "right",
  iframeMode: true,
  livePreview: true,
  quickLinks: [],
  onboarded: false,
  debug: false,
  handPose: "twoFingers",
};

/**
 * Chips are placed evenly around the rim, so this is bounded by how many labels
 * fit on a circle before they collide, not by storage. Eight still reads.
 */
export const MAX_QUICK_LINKS = 8;

const KEY = "slingtab:settings";

/**
 * The key used before the extension was renamed from Aperture.
 *
 * Read as a fallback, and deleted on the next write. Without it the rename
 * silently resets everyone's trigger, quick links and preview settings to the
 * defaults — a rename is not a reason to lose someone's configuration.
 */
const LEGACY_KEY = "aperture:settings";

function coerce(raw: unknown): Settings {
  const o = (raw ?? {}) as Partial<Settings>;
  const links = Array.isArray(o.quickLinks) ? o.quickLinks : [];
  const from = typeof o.schema === "number" ? o.schema : 0;
  return {
    schema: SETTINGS_SCHEMA,
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_SETTINGS.enabled,
    trigger:
      o.trigger === "alt" || o.trigger === "hand" ? o.trigger : "right",
    // Both default ON, so an absent field must read as true. `=== true` here
    // would silently disable the preview for everyone whose stored settings
    // predate the field — and a stored `false` from before schema 2 is not a
    // choice worth preserving, for the reason above SETTINGS_SCHEMA.
    iframeMode: from >= 2 ? o.iframeMode !== false : true,
    livePreview: o.livePreview !== false,
    quickLinks: links
      .filter(
        (l): l is QuickLink =>
          !!l && typeof l.url === "string" && /^https?:\/\//i.test(l.url),
      )
      .slice(0, MAX_QUICK_LINKS)
      .map((l) => ({ url: l.url, label: String(l.label ?? "").slice(0, 32) })),
    onboarded: o.onboarded === true,
    debug: o.debug === true,
    handPose: o.handPose === "any" ? "any" : "twoFingers",
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const got = await chrome.storage.sync.get([KEY, LEGACY_KEY]);
    return coerce(got?.[KEY] ?? got?.[LEGACY_KEY]);
  } catch {
    // Extension context invalidated, or storage unavailable. Never throw into
    // the animation loop; degrade to defaults.
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await write(coerce(s));
}

/** One write path, so the pre-rename key is always cleaned up exactly once. */
async function write(next: Settings): Promise<void> {
  await chrome.storage.sync.set({ [KEY]: next });
  try {
    await chrome.storage.sync.remove(LEGACY_KEY);
  } catch {
    /* nothing to remove, or storage is gone; the fallback read still works */
  }
}

/**
 * Read-modify-write a single field.
 *
 * Always prefer this over building a whole Settings object from a form's DOM
 * and saving that. Two UIs now edit the same settings (the popup and the
 * options page) and neither shows every field, so a whole-object save silently
 * resets whatever the page does not render — which is exactly how changing an
 * unrelated checkbox in the options page used to reset the trigger and, if the
 * form had not finished populating, write `enabled: false` and kill the
 * extension outright.
 */
export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = coerce({ ...current, ...patch });
  await write(next);
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      const hit = changes[KEY] ?? changes[LEGACY_KEY];
      if (!hit) return;
      cb(coerce(hit.newValue));
    });
  } catch {
    /* no-op */
  }
}
