import { afterEach, describe, expect, it, vi } from "vitest";
import { routeWasmLog } from "../src/shared/handtrack";

/**
 * MediaPipe's WASM runtime writes glog lines to stderr, and Emscripten binds
 * stderr to console.error — which is the stream chrome://extensions collects
 * into an extension's Errors list. A healthy load filled that list with
 * warnings about MediaPipe's own graph.
 *
 * The rule is a demotion, not a mute: INFO and WARNING go to console.debug,
 * everything else stays an error. These tests pin both halves, because losing
 * the second half is how a real failure goes silent.
 */

afterEach(() => vi.restoreAllMocks());

function capture(line: string): "debug" | "error" {
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  routeWasmLog(line);
  return debug.mock.calls.length === 1 && error.mock.calls.length === 0
    ? "debug"
    : "error";
}

describe("routeWasmLog", () => {
  it("demotes the lines the extensions page was collecting", () => {
    expect(
      capture(
        "W0825 08:07:19.622000 2196592 gl_context.cc:1119] OpenGL error checking is disabled",
      ),
    ).toBe("debug");
    expect(
      capture(
        "W0825 08:07:19.792999 2196592 landmark_projection_calculator.cc:81] Using NORM_RECT without IMAGE_DIMENSIONS is only supported for the square ROI. Provide IMAGE_DIMENSIONS or use PROJECTION_MATRIX.",
      ),
    ).toBe("debug");
  });

  it("demotes INFO as well", () => {
    expect(capture("I0825 08:07:19.100000 2196592 graph.cc:12] Started")).toBe("debug");
  });

  it("keeps ERROR and FATAL as errors", () => {
    expect(capture("E0825 08:07:19.100000 2196592 calculator.cc:9] Bad")).toBe("error");
    expect(capture("F0825 08:07:19.100000 2196592 calculator.cc:9] Worse")).toBe("error");
  });

  it("keeps anything that is not a glog line as an error", () => {
    // Emscripten aborts, uncaught C++ exceptions, our own messages: none of
    // these carry the prefix, and none of them may be quietly demoted.
    expect(capture("Aborted(OOM)")).toBe("error");
    expect(capture("W is for warning, but this is prose")).toBe("error");
    expect(capture("")).toBe("error");
  });
});
