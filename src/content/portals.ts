/**
 * Every portal currently on screen.
 *
 * The content script used to hold a SINGLE reference to the open portal. That
 * is enough right up until something clears or overwrites it while the portal
 * it named is still running — and two separate races did exactly that. The
 * result each time was a portal nothing could reach: not the next gesture, not
 * a click, not a key. It kept its overlay and its rAF loop until the five
 * minute safety valve, and every further gesture stacked another one beside it.
 *
 * Fixing those races one at a time did not hold, because the failure is not any
 * particular race — it is that a single reference cannot survive one. So the
 * invariant moved here: a portal is registered the moment it exists, removed
 * when it finishes, and `closeAll` reaches all of them. Nothing has to be
 * diagnosed for the screen to end up clean.
 *
 * Structurally typed on purpose, so this file stays free of the DOM and can be
 * tested against fakes.
 */
export interface Closeable {
  /** Close gracefully: fades out, then removes itself. */
  dismiss(): void;
  /** Close now, in one frame. Must be idempotent and always deregister. */
  teardown(): void;
}

export class PortalRegistry {
  private readonly live = new Set<Closeable>();

  get size(): number {
    return this.live.size;
  }

  add(portal: Closeable): void {
    this.live.add(portal);
  }

  remove(portal: Closeable): void {
    this.live.delete(portal);
  }

  /**
   * Close everything, newest first.
   *
   * The most recent portal is the one the user was looking at, so it gets the
   * dissipate animation. Anything still on screen behind it has already
   * outstayed its welcome and goes at once — which is what bounds the screen at
   * two portals, one fading and one arriving, no matter how they got there.
   *
   * Iterates a copy: `teardown` deregisters synchronously through `onFinished`.
   */
  closeAll(): void {
    let newest = true;
    for (const portal of [...this.live].reverse()) {
      if (newest) {
        newest = false;
        portal.dismiss();
      } else {
        portal.teardown();
      }
    }
  }
}

/** Anything that can be taken off the page. */
export interface Disposable {
  destroy(): void;
}

/**
 * A set that never holds more than one member.
 *
 * Used for overlays, where "one ring at a time" has to be true by construction.
 * Every attempt to maintain it from the objects that OWN overlays has leaked,
 * because an overlay can outlive every reference to it: `HandPreview.release()`
 * cancels its rAF and hands the overlay out, so a caller that drops it leaves a
 * host in the document that no object points at and nothing redraws — and a
 * canvas keeps its last frame, so what remains on screen is a fully lit ring,
 * frozen and unreachable. Enforcing exclusivity where overlays are CREATED
 * needs no cooperation from anything that holds one.
 */
export class ExclusiveSet<T extends Disposable> {
  private readonly live = new Set<T>();

  get size(): number {
    return this.live.size;
  }

  /** Register `item` and destroy everything else. */
  add(item: T): void {
    this.live.add(item);
    this.keepOnly(item);
  }

  /** Deregister without destroying. Call from the member's own destroy(). */
  remove(item: T): void {
    this.live.delete(item);
  }

  /** Destroy every member except `keep`. Iterates a copy: destroy deregisters. */
  keepOnly(keep: T | null): void {
    for (const item of [...this.live]) {
      if (item !== keep) item.destroy();
    }
  }
}

/**
 * Would a screenshot of the tab, taken right now, contain something of ours?
 *
 * `captureVisibleTab` photographs the COMPOSITED tab, and our overlay is part
 * of the page. A snapshot taken while a ring is visible contains that ring; the
 * lens then draws that snapshot inside the next portal, and the ring is back as
 * pixels in a texture that nothing owns, nothing redraws and no teardown can
 * remove. Repeat and they stack.
 *
 * `sinceGoneMs` is not paranoia. Removing an overlay does not repaint the tab —
 * the compositor gets to it on its own schedule — so a capture requested in the
 * same task as a teardown still photographs what was just removed. The grace
 * period covers the dissipate animation and a frame beyond it.
 */
export function screenIsDirty(
  state: { overlays: number; preview: boolean; sinceGoneMs: number },
  graceMs = 400,
): boolean {
  return state.overlays > 0 || state.preview || state.sinceGoneMs < graceMs;
}
