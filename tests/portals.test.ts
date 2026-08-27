import { describe, expect, it } from "vitest";
import {
  ExclusiveSet,
  PortalRegistry,
  screenIsDirty,
  type Closeable,
} from "../src/content/portals";

/**
 * The invariant that broke twice: a portal on screen must always be closeable.
 *
 * Both failures looked like the screenshots users sent - two rings, then three,
 * each stranded where it was drawn, none of them responding to a click, a key
 * or another gesture. Both were races that cleared the single `active`
 * reference while the portal it named was still running, and fixing the first
 * one individually did not prevent the second.
 */

/** A portal that behaves: dissipates over time, deregisters when it finishes. */
function portal(reg: PortalRegistry, log: string[], name: string): Closeable {
  let finished = false;
  const self: Closeable = {
    dismiss() {
      if (finished) return;
      log.push(`${name}:dismiss`);
      // A real dismiss starts an animation; it deregisters ~380ms later.
    },
    teardown() {
      if (finished) return;
      finished = true;
      log.push(`${name}:teardown`);
      reg.remove(self);
    },
  };
  reg.add(self);
  return self;
}

describe("PortalRegistry", () => {
  it("closes the only portal gracefully", () => {
    const reg = new PortalRegistry();
    const log: string[] = [];
    portal(reg, log, "a");
    reg.closeAll();
    expect(log).toEqual(["a:dismiss"]);
  });

  /**
   * The shape of the bug. Two portals are on screen because a race let a second
   * one open while the first was still live. Closing must reach BOTH - the old
   * code only ever touched the one `active` happened to name.
   */
  it("reaches every portal, not just the newest", () => {
    const reg = new PortalRegistry();
    const log: string[] = [];
    portal(reg, log, "a");
    portal(reg, log, "b");
    portal(reg, log, "c");

    reg.closeAll();

    // Newest fades; the ones stranded behind it go at once.
    expect(log).toEqual(["c:dismiss", "b:teardown", "a:teardown"]);
  });

  it("leaves nothing behind that was not already fading", () => {
    const reg = new PortalRegistry();
    const log: string[] = [];
    portal(reg, log, "a");
    portal(reg, log, "b");
    portal(reg, log, "c");

    reg.closeAll();
    // `c` is mid-dissipate and still registered; a and b are gone.
    expect(reg.size).toBe(1);
  });

  it("survives repeated gestures without accumulating", () => {
    const reg = new PortalRegistry();
    const log: string[] = [];
    for (let i = 0; i < 20; i++) {
      reg.closeAll();
      portal(reg, log, `p${i}`);
      // At most the one fading plus the one just opened.
      expect(reg.size, `after gesture ${i}`).toBeLessThanOrEqual(2);
    }
  });

  it("is safe on an empty registry", () => {
    const reg = new PortalRegistry();
    expect(() => reg.closeAll()).not.toThrow();
    expect(reg.size).toBe(0);
  });

  it("tolerates teardown deregistering during iteration", () => {
    const reg = new PortalRegistry();
    const log: string[] = [];
    for (let i = 0; i < 5; i++) portal(reg, log, `p${i}`);
    expect(() => reg.closeAll()).not.toThrow();
    expect(log.filter((l) => l.endsWith(":teardown"))).toHaveLength(4);
  });

  it("a portal that finishes on its own is no longer closed", () => {
    const reg = new PortalRegistry();
    const log: string[] = [];
    const a = portal(reg, log, "a");
    a.teardown();
    log.length = 0;

    portal(reg, log, "b");
    reg.closeAll();
    expect(log).toEqual(["b:dismiss"]);
  });
});

/**
 * One overlay at a time, guaranteed where overlays are created.
 *
 * The case no registry of PORTALS can cover: `HandPreview.release()` cancels its
 * rAF and hands the overlay out, so a caller that drops it leaves a host in the
 * document that no object points at and nothing redraws. A canvas keeps its
 * last frame, so what stays on screen is a fully lit ring — frozen, unreachable
 * and unclosable, one more per gesture.
 */
describe("ExclusiveSet", () => {
  const make = (log: string[], name: string) => {
    let dead = false;
    return {
      name,
      destroy() {
        if (dead) return;
        dead = true;
        log.push(name);
      },
      get dead() {
        return dead;
      },
    };
  };

  it("destroys the previous member when a new one arrives", () => {
    const set = new ExclusiveSet<ReturnType<typeof make>>();
    const log: string[] = [];
    const a = make(log, "a");
    set.add(a);
    set.add(make(log, "b"));
    expect(log).toEqual(["a"]);
    expect(a.dead).toBe(true);
    expect(set.size).toBe(2); // `a` has not deregistered itself in this fake
  });

  it("keeps only one when several are already stranded", () => {
    const set = new ExclusiveSet<ReturnType<typeof make>>();
    const log: string[] = [];
    // Three overlays that never deregistered - the shape of the bug.
    const a = make(log, "a");
    const b = make(log, "b");
    const c = make(log, "c");
    for (const x of [a, b, c]) set["live"].add(x);

    set.keepOnly(c);
    expect(log.sort()).toEqual(["a", "b"]);
    expect(c.dead).toBe(false);
  });

  it("keepOnly(null) clears everything", () => {
    const set = new ExclusiveSet<ReturnType<typeof make>>();
    const log: string[] = [];
    set["live"].add(make(log, "a"));
    set["live"].add(make(log, "b"));
    set.keepOnly(null);
    expect(log.sort()).toEqual(["a", "b"]);
  });

  it("a member that deregisters on destroy leaves the set empty", () => {
    const set = new ExclusiveSet<{ destroy(): void }>();
    const wellBehaved = {
      destroy() {
        set.remove(wellBehaved);
      },
    };
    set.add(wellBehaved);
    const next = { destroy() {} };
    set.add(next);
    expect(set.size).toBe(1);
  });

  it("twenty gestures in a row never accumulate", () => {
    const set = new ExclusiveSet<{ destroy(): void }>();
    for (let i = 0; i < 20; i++) {
      const o: { destroy(): void } = { destroy: () => set.remove(o) };
      set.add(o);
      expect(set.size, `after ${i}`).toBe(1);
    }
  });
});

/**
 * When a screenshot of the tab is safe to take.
 *
 * The failure this pins was invisible in the object graph: the overlays WERE
 * being destroyed correctly, and the rings still came back. They were coming
 * back inside the picture. `captureVisibleTab` photographs the composited tab,
 * our overlay is part of it, and the lens then draws that photograph inside the
 * next portal — so a ring removed from the DOM reappeared as pixels in a
 * texture, frozen, owned by nothing. Each gesture photographed the last one.
 */
describe("screenIsDirty", () => {
  const clean = { overlays: 0, preview: false, sinceGoneMs: 10_000 };

  it("is clean when nothing has been on screen for a while", () => {
    expect(screenIsDirty(clean)).toBe(false);
  });

  it("is dirty while a portal is open", () => {
    expect(screenIsDirty({ ...clean, overlays: 1 })).toBe(true);
  });

  it("is dirty while the hand preview is drawing", () => {
    expect(screenIsDirty({ ...clean, preview: true })).toBe(true);
  });

  /**
   * The ordering trap. Removing an overlay does not repaint the tab, so the
   * count going to zero is not the same as the screen being clean.
   */
  it("stays dirty just after the last overlay was removed", () => {
    expect(screenIsDirty({ overlays: 0, preview: false, sinceGoneMs: 0 })).toBe(true);
    expect(screenIsDirty({ overlays: 0, preview: false, sinceGoneMs: 399 })).toBe(true);
  });

  it("goes clean once the compositor has had time", () => {
    expect(screenIsDirty({ overlays: 0, preview: false, sinceGoneMs: 401 })).toBe(false);
  });

  it("covers the dissipate animation", () => {
    // T_DISSIPATE is 380ms; the grace period must outlast it.
    expect(screenIsDirty({ overlays: 0, preview: false, sinceGoneMs: 380 })).toBe(true);
  });
});
