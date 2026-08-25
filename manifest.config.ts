import { defineManifest } from "@crxjs/vite-plugin";

/**
 * SlingTab — gesture-driven portal navigation.
 *
 * Permission notes (deliberate, do not "simplify"):
 *  - No `tabs`: the service worker reads the tab id from `sender.tab.id`, which needs no permission.
 *  - `declarativeNetRequestWithHostAccess`, never the unqualified `declarativeNetRequest`:
 *    the qualified form is scoped to hosts we already hold and shows no install-time warning.
 *  - `favicon` powers the `_favicon/` fallback image for the portal preview.
 */
export default defineManifest({
  manifest_version: 3,
  name: "SlingTab",
  version: "0.1.0",
  description:
    "Cast a sling ring, draw a circle, and step through a portal into any link.",
  minimum_chrome_version: "120",
  // `offscreen` powers the webcam trigger: getUserMedia from a content script
  // would prompt per site on the *page's* origin, whereas an offscreen document
  // runs on the extension's origin and is asked once. USER_MEDIA is the
  // sanctioned reason for one.
  permissions: [
    "storage",
    "declarativeNetRequestWithHostAccess",
    "favicon",
    "offscreen",
  ],
  host_permissions: ["<all_urls>"],
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },
  action: {
    default_title: "SlingTab",
    default_popup: "popup.html",
    default_icon: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_start",
      all_frames: false,
      world: "ISOLATED",
    },
  ],
  options_page: "options.html",
  // MediaPipe runs the hand landmark model in WebAssembly. MV3 forbids wasm
  // compilation on extension pages unless this is declared; without it the
  // offscreen tracker silently falls back to the far worse blob detector.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
});
