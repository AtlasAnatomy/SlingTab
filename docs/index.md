---
layout: default
title: SlingTab Privacy Policy
description: What SlingTab reads, what it never sends, and exactly what it changes on the network.
---

# SlingTab Privacy Policy

**Last updated: 25 August 2026**

SlingTab has no accounts, no servers, no analytics and no telemetry. It sends nothing about you anywhere. There is no backend to send it to.

This page describes exactly what the extension touches, and it is written to be checkable: every claim below points at the file that implements it, in a repository you can read.

---

## The short version

| | |
|---|---|
| **Webcam** | Frames are read in memory, measured, and discarded. Only numbers ever leave the tracker. |
| **Screenshots** | A capture of your own visible tab, held in memory, dropped when the portal closes. |
| **MediaPipe telemetry** | Disabled at build time. The build fails if the endpoint ever stops being found. |
| **Destination fetch** | Circling a link fetches that URL, without cookies, to build the preview. |
| **Header stripping** | For up to 5 seconds, framing protection is removed for one host in one tab. Details below. |
| **Stored on disk** | Your settings and quick links. Nothing else. |

---

## The webcam

The hand trigger is optional and off by default. When it is off, the camera is never opened.

When it is on, frames go to a hand-landmark model that is **bundled inside the extension** and runs locally. No frame, no image, and no derivative of a frame is transmitted anywhere. The model works with the network disconnected, because nothing about it is remote.

What the tracker emits, per frame, is a short list of numbers: a fingertip position, an optional fitted circle, and a status flag. That is the entire output surface ([`src/offscreen/hand.ts`](https://github.com/AtlasAnatomy/SlingTab/blob/main/src/offscreen/hand.ts)):

```js
{ type: "HAND_PREVIEW", pointerXFrac, pointerYFrac,
  centerXFrac, centerYFrac, radiusFrac, startAngle, direction, progress }
```

Coordinates, not pixels. There is no code path in this extension that encodes, stores or uploads a camera frame.

The camera runs only while the hand trigger is selected. Change the trigger and the tracker stops.

---

## The page screenshot

The lens effect bends a still image of the page you are already looking at. That image comes from `chrome.tabs.captureVisibleTab` on **your own active tab** ([`src/background/index.ts`](https://github.com/AtlasAnatomy/SlingTab/blob/main/src/background/index.ts)).

- It is a JPEG held in memory and handed to the content script that draws the effect.
- It is never written to disk, never uploaded, and never sent to any origin.
- It is dropped when the portal closes.
- Capture only ever targets the sender's own tab. SlingTab cannot capture a background tab, and does not hold the `tabs` permission that would let it enumerate your tabs at all.

If the capture fails, whether from rate limiting or because the page forbids it, the lens simply stays off and navigation continues.

---

## MediaPipe telemetry is removed at build time

The upstream `@mediapipe/tasks-vision` library ships a usage logger that batches events and POSTs them to a Google endpoint every 60 seconds, with an API key header.

That is switched off before the extension is ever packaged. A build plugin rewrites the endpoint to an extension-relative path that returns 404 ([`vite.config.ts`](https://github.com/AtlasAnatomy/SlingTab/blob/main/vite.config.ts)). MediaPipe's own error handling then clears its interval and disables the logger permanently, so exactly one request is ever attempted and it never leaves the browser.

**The guard matters more than the fix.** If a future MediaPipe upgrade renames or removes that endpoint, the build *fails* rather than silently shipping a working logger. A dependency bump cannot quietly reintroduce it.

You can verify this on any build:

```sh
npm run build && grep -r "odml.pa.googleapis" dist/
```

That returns nothing.

---

## Circling a link fetches it

This is the one thing SlingTab does that a person might not expect, so it is stated plainly rather than buried.

When you circle a link, the extension fetches that URL to build the preview shown inside the portal: a title, a theme colour, and an image where the site offers one. The site therefore learns you looked at the link, in the same way a hover-prefetch would.

The fetch uses **`credentials: "omit"`**, so no cookies and no authentication are sent, and nothing personalised is pulled back. The response only ever becomes an image and a few strings, drawn into a closed shadow root that the surrounding page cannot read.

Private and intranet addresses are deliberately **not** blocked. Circling a link on `localhost` or a company intranet is a legitimate thing to do, and blocking it would break the preview there without making anything safer.

---

## Header stripping, in full

This is the most invasive thing SlingTab does, and it is a user-facing setting you can switch off.

### Why it exists

Most sites refuse to be displayed inside a frame. They say so with the `X-Frame-Options` response header, or with `frame-ancestors` inside `Content-Security-Policy`. Without removing those, the portal cannot show the real destination and falls back to a composed card for nearly every link you would actually click.

When **"Show it for sites that refuse framing too"** is enabled, SlingTab installs a temporary network rule that removes those headers from the destination's response.

### Exactly what is removed

The amount depends on where the link points ([`src/background/dnr.ts`](https://github.com/AtlasAnatomy/SlingTab/blob/main/src/background/dnr.ts)):

| Destination | Headers removed | Why |
|---|---|---|
| **Cross-origin** | `X-Frame-Options`, `Content-Security-Policy`, `Content-Security-Policy-Report-Only` | `frame-ancestors` lives inside the CSP, and a network rule can drop a header but not edit one. Refusing sites cannot be framed without taking the whole header. |
| **Same-origin** | `X-Frame-Options` only | A same-site frame *does* carry your cookies, so the CSP is left intact rather than stripping `script-src` from an authenticated document. |

### The part that is wider than it should be

**While the rule is active, it applies to every sub-frame request to that host in that tab — not only to SlingTab's own iframe.**

This is a genuine limitation and it is not fixed. Chrome's `declarativeNetRequest` API can scope a rule to a URL pattern, a resource type, and a tab. It cannot scope one to a single frame or a single element. There is no API to say "this iframe only", so the rule is as narrow as the platform permits and no narrower.

The practical consequence: for the duration of the window, a page in that tab that embeds a frame pointing at the same host would also receive the stripped response, and would get a frame without that host's clickjacking protection.

Four things bound it.

1. **It requires a deliberate gesture** from you, on a link to that exact host.
2. **It is scoped to one host, one tab, and sub-frame requests only.** It never touches top-level navigation, and never touches other tabs.
3. **It is released as early as possible.** The rule is dropped the moment SlingTab's own preview loads, or on navigation, or if you dismiss the portal, or if the tab closes. In normal use the window is a few hundred milliseconds.
4. **A 5-second watchdog is the hard ceiling.** Whatever happens, including a service worker killed mid-portal, the rule is gone within 5 seconds. The extension also sweeps every rule it owns on startup, and rules are session-scoped, so none can survive a browser restart.

### Turning it off

Uncheck **"Show it for sites that refuse framing too"** in SlingTab's settings. No rule is then ever created, and the portal shows a composed card built from the favicon, hostname, title and theme colour instead.

### A related note on framed pages

A site framed inside the portal will usually appear **logged out**. Cookies marked `SameSite=Lax` are not sent to a cross-site frame. The preview also cannot be interacted with: pointer events are off, forms and popups are blocked, and it can never navigate your tab.

---

## What is stored

Your settings and your quick links, in Chrome's extension storage on your own machine. That is all.

SlingTab does **not** store your browsing history, and does not record the URLs you travel to. An earlier version kept a handoff record of the destination; it was removed.

---

## Permissions, and why each one exists

| Permission | Why |
|---|---|
| `<all_urls>` | The gesture has to work on any page, and the page snapshot has to be capturable there. |
| `storage` | Your settings and quick links. |
| `declarativeNetRequestWithHostAccess` | The framing rule described above. This is the host-scoped variant, deliberately. |
| `favicon` | Drawing site icons on the quick-link chips and the fallback card. |
| `offscreen` | Somewhere for the webcam tracker to run. A content script asking for the camera would prompt in the *page's* name. |

Not requested: **`tabs`** (the worker reads the sender's own tab id), `scripting`, `webRequest`, `cookies`, `downloads`, `history`, `bookmarks`.

No web page can send messages to the extension. There is no `externally_connectable`.

---

## One known disclosure

The build toolchain must list SlingTab's content-script file in `web_accessible_resources`, at a path that stays the same for a published extension. Any website can therefore probe that path and learn that you have SlingTab installed.

The documented mitigation for this breaks the extension entirely, so it is **accepted rather than fixed**, and disclosed here rather than left for someone to discover. It reveals that the extension is installed. It reveals nothing about you, your browsing, or your camera.

---

## Changes

This policy is versioned in the repository. Its history is the changelog:
[`docs/index.md`](https://github.com/AtlasAnatomy/SlingTab/commits/main/docs/index.md).

## Contact

Questions or corrections: [open an issue](https://github.com/AtlasAnatomy/SlingTab/issues).

---

<sub>SlingTab is free software under the [MIT License](https://github.com/AtlasAnatomy/SlingTab/blob/main/LICENSE). Source: [github.com/AtlasAnatomy/SlingTab](https://github.com/AtlasAnatomy/SlingTab)</sub>
