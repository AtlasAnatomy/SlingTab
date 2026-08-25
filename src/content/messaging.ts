import type { Msg } from "../shared/types";

/**
 * §11: every sendMessage from a content script must reject cleanly. A dead
 * service worker, or an extension context invalidated by a reload/update,
 * otherwise throws straight into the animation loop.
 */
export function send<T>(msg: Msg, timeoutMs = 2000): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const done = (v: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);

    try {
      chrome.runtime.sendMessage(msg, (res: unknown) => {
        // Reading lastError is what suppresses the "Unchecked runtime.lastError"
        // console noise when the worker is gone.
        void chrome.runtime.lastError;
        done((res ?? null) as T | null);
      });
    } catch {
      done(null);
    }
  });
}
