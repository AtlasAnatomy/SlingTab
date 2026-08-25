import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression cover for a reported bug: changing any single control in the
 * options page reset unrelated settings. The options form does not render every
 * field (the popup owns some), so rebuilding a whole Settings object from its
 * DOM wrote defaults over everything it could not see — resetting the trigger
 * away from "hand", and, if the form had not finished populating, writing
 * `enabled: false` and killing the extension outright.
 */

const store: Record<string, unknown> = {};

vi.stubGlobal("chrome", {
  storage: {
    sync: {
      get: async (keys: string | string[]) =>
        Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).map((k) => [k, store[k]]),
        ),
      set: async (obj: Record<string, unknown>) => Object.assign(store, obj),
      remove: async (key: string) => {
        delete store[key];
      },
    },
    onChanged: { addListener: () => {} },
  },
});

const { DEFAULT_SETTINGS, SETTINGS_SCHEMA, loadSettings, patchSettings, saveSettings } =
  await import("../src/shared/settings");

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("patchSettings", () => {
  it("leaves every field it was not given alone", async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      enabled: true,
      trigger: "hand",
      iframeMode: true,
      quickLinks: [{ url: "https://example.com", label: "Example" }],
      onboarded: true,
    });

    // The options page toggling an unrelated checkbox.
    await patchSettings({ debug: true });

    const s = await loadSettings();
    expect(s.debug).toBe(true);
    expect(s.trigger).toBe("hand");
    expect(s.enabled).toBe(true);
    expect(s.iframeMode).toBe(true);
    expect(s.quickLinks).toHaveLength(1);
    expect(s.onboarded).toBe(true);
  });

  it("round-trips the hand trigger", async () => {
    await patchSettings({ trigger: "hand" });
    expect((await loadSettings()).trigger).toBe("hand");

    await patchSettings({ trigger: "alt" });
    expect((await loadSettings()).trigger).toBe("alt");

    // Anything unrecognised falls back to the default rather than persisting.
    await patchSettings({ trigger: "nonsense" as never });
    expect((await loadSettings()).trigger).toBe("right");
  });

  it("never silently disables the extension", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, enabled: true });
    for (const p of [{ debug: true }, { iframeMode: true }, { onboarded: true }]) {
      await patchSettings(p);
      expect((await loadSettings()).enabled, JSON.stringify(p)).toBe(true);
    }
    // Only an explicit patch may turn it off.
    await patchSettings({ enabled: false });
    expect((await loadSettings()).enabled).toBe(false);
  });

  it("returns the merged result so callers can repaint without re-reading", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, trigger: "hand" });
    const next = await patchSettings({ enabled: false });
    expect(next.trigger).toBe("hand");
    expect(next.enabled).toBe(false);
  });
});

describe("loadSettings", () => {
  it("defaults cleanly when storage is empty", async () => {
    const s = await loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps the two preview modes on for settings written before they existed", async () => {
    // Both coerce with `!== false`. Writing `=== true` instead would read an
    // absent field as off and silently leave every upgrading user with a logo in
    // the disc instead of the destination page.
    store["slingtab:settings"] = { enabled: true, trigger: "right" };
    const s = await loadSettings();
    expect(s.iframeMode).toBe(true);
    expect(s.livePreview).toBe(true);
  });

  it("migrates a pre-schema-2 `iframeMode: false` back on", async () => {
    // Mode A was dead code before schema 2 — `framable` and `nativelyFramable`
    // held the same value, so turning it off preserved no working behaviour.
    // Anyone carrying that stored `false` would otherwise never see the live
    // preview at all.
    store["slingtab:settings"] = { enabled: true, iframeMode: false };
    expect((await loadSettings()).iframeMode).toBe(true);
  });

  it("respects `iframeMode: false` once it was chosen against schema 2", async () => {
    store["slingtab:settings"] = { enabled: true, iframeMode: false, schema: 2 };
    expect((await loadSettings()).iframeMode).toBe(false);
  });

  it("stamps the current schema on everything it writes", async () => {
    store["slingtab:settings"] = { enabled: true };
    expect((await patchSettings({ debug: true })).schema).toBe(SETTINGS_SCHEMA);
  });

  it("reads settings written under the pre-rename key", async () => {
    // A rename must not reset anyone's configuration.
    store["aperture:settings"] = { enabled: true, trigger: "hand", debug: true };
    const s = await loadSettings();
    expect(s.trigger).toBe("hand");
    expect(s.debug).toBe(true);
  });

  it("moves the old key to the new one on the next write, once", async () => {
    store["aperture:settings"] = { enabled: true, trigger: "alt", schema: 2 };
    await patchSettings({ debug: true });
    expect(store["slingtab:settings"]).toBeDefined();
    expect(store["aperture:settings"]).toBeUndefined();
    expect((await loadSettings()).trigger).toBe("alt");
  });

  it("prefers the new key when both exist", async () => {
    store["aperture:settings"] = { enabled: true, trigger: "hand" };
    store["slingtab:settings"] = { enabled: true, trigger: "alt", schema: 2 };
    expect((await loadSettings()).trigger).toBe("alt");
  });

  it("still lets both be turned off explicitly", async () => {
    await patchSettings({ iframeMode: false, livePreview: false });
    const s = await loadSettings();
    expect(s.iframeMode).toBe(false);
    expect(s.livePreview).toBe(false);
  });

  it("drops quick links that are not http(s)", async () => {
    await patchSettings({
      quickLinks: [
        { url: "https://ok.com", label: "ok" },
        { url: "javascript:alert(1)", label: "bad" },
        { url: "chrome://settings", label: "bad" },
      ] as never,
    });
    const s = await loadSettings();
    expect(s.quickLinks.map((l) => l.url)).toEqual(["https://ok.com"]);
  });
});
