import { defineConfig } from "vite";

/**
 * Standalone config for the rim tuner (`npm run tune`).
 *
 * Deliberately does NOT load @crxjs: the tuner is a plain page that imports the
 * renderer directly, and the extension build pipeline would only get in the way
 * of the one thing this exists for — instant HMR on the shaders.
 */
export default defineConfig({
  root: "tools",
  server: {
    port: 5180,
    open: "/tune.html",
    // The tuner imports from ../src, which is outside `root`.
    fs: { allow: [".."] },
  },
});
