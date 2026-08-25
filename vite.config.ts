import { defineConfig, type Plugin } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

/*
 * There used to be a third plugin here that post-processed the generated
 * manifest, for two jobs that no longer exist.
 *
 * 1. It spliced `public/prelude.js` in ahead of the content script. The arrival
 *    animation needed a visibility guard as the first SYNCHRONOUS statement at
 *    document_start, and @crxjs ships every entry behind an async `import()`
 *    loader, so the guard could not live in the bundle. The arrival animation
 *    is gone (bug 33), and with it the guard and the service-worker round trip
 *    it waited on — both of which delayed first paint on EVERY page load in the
 *    browser, not only on a portal arrival.
 *
 * 2. It set `use_dynamic_url: true` on the web_accessible_resources entries.
 *    DO NOT reinstate that. @crxjs has to expose the content-script chunk
 *    there, because a dynamic `import()` of an extension URL from a content
 *    script requires it, and a fixed path under a published extension's fixed
 *    id is a presence beacon any site can probe for — so the reasoning was
 *    sound. The mechanism was not: with the flag on, Chrome refuses the static
 *    path outright ("Denying load of chrome-extension://<id>/assets/*.js") and
 *    @crxjs's loader dies on "Failed to fetch dynamically imported module". No
 *    content script, no gesture, and nothing in the extension's own error list
 *    to explain it. The fingerprinting exposure is real and accepted; HANDOFF
 *    §13 says so out loud.
 */

const MP_TELEMETRY = "https://odml.pa.googleapis.com/v1/log";

/**
 * Neuters MediaPipe's usage telemetry.
 *
 * @mediapipe/tasks-vision ships a logger that batches events and POSTs them to
 * Google every 60 seconds with an x-goog-api-key header. This extension watches
 * a webcam; it promises the user that nothing leaves the machine, and that
 * promise has to be true at the network layer, not just in the privacy copy.
 *
 * The URL is rewritten to an extension-relative path that 404s. MediaPipe's own
 * error path then clears the interval and disables the logger permanently, so
 * exactly one request is attempted and it never leaves the browser.
 *
 * If a MediaPipe upgrade renames or removes the endpoint, this FAILS THE BUILD
 * rather than silently letting telemetry back in.
 */
function blockMediapipeTelemetry(): Plugin {
  let patched = 0;
  return {
    name: "slingtab:block-mediapipe-telemetry",
    apply: "build",
    renderChunk(code) {
      if (!code.includes(MP_TELEMETRY)) return null;
      patched++;
      return { code: code.split(MP_TELEMETRY).join("/telemetry-disabled"), map: null };
    },
    closeBundle() {
      if (patched === 0) {
        this.error(
          "MediaPipe telemetry endpoint not found. It was renamed, removed, or " +
            "the bundle changed shape — re-check @mediapipe/tasks-vision for " +
            "outbound requests before shipping.",
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [crx({ manifest }), blockMediapipeTelemetry()],
  build: {
    target: "esnext",
    modulePreload: false,
    rollupOptions: {
      input: {
        options: "options.html",
        popup: "popup.html",
        camera: "camera.html",
        // Not referenced from the manifest (chrome.offscreen takes the path at
        // runtime), so @crxjs never discovers it. Declare it explicitly or it
        // is silently absent from dist/ and the webcam trigger dies with a
        // "Could not load" error nobody sees.
        offscreen: "src/offscreen/hand.html",
      },
    },
  },
});
