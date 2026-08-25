import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWasmLogSink, routeWasmLog } from "../src/shared/handtrack";

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

  it("demotes TFLite's own logger, which does not use the glog prefix", () => {
    // The CPU delegate is built by TFLite, not by the graph runner, and it
    // announces itself through a different logger with a different shape. It is
    // the single most common line in the whole load and it was landing in the
    // extensions card as an error on every start.
    expect(capture("INFO: Created TensorFlow Lite XNNPACK delegate for CPU.")).toBe(
      "debug",
    );
    expect(capture("WARNING: Falling back to the reference implementation.")).toBe(
      "debug",
    );
  });

  it("keeps TFLite errors as errors", () => {
    expect(capture("ERROR: Could not open model.")).toBe("error");
  });

  it("keeps anything that is not a glog line as an error", () => {
    // Emscripten aborts, uncaught C++ exceptions, our own messages: none of
    // these carry the prefix, and none of them may be quietly demoted.
    expect(capture("Aborted(OOM)")).toBe("error");
    expect(capture("W is for warning, but this is prose")).toBe("error");
    expect(capture("")).toBe("error");
  });
});

/**
 * The GPU attempt is a probe, not a load.
 *
 * `load()` builds the landmarker on the GPU delegate first and retries on CPU
 * when that throws, because an offscreen document is not rendered and some
 * drivers refuse it there. On those machines the refusal is not an anomaly —
 * it is the normal path, every single start, and MediaPipe announces it on
 * stderr at ERROR level:
 *
 *     E0825 10:14:04.401999 … StartGraph failed: NOT_FOUND: Unable to open
 *     file at /model.dat; Initialize was not ok
 *
 * The JS-level throw from that same attempt is already treated as expected.
 * The runtime's stderr from it was not, so every start deposited an error in
 * the extensions card and they piled up across worker restarts.
 *
 * So the probe's output is demoted wholesale, and only for as long as the probe
 * is running. Emscripten reads `printErr` once and keeps it for the life of the
 * instance, so a GPU attempt that SUCCEEDS must not leave a permanently muted
 * runtime behind — `settle()` is what puts the level rule back.
 */
describe("makeWasmLogSink", () => {
  function sink(speculative: boolean) {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = makeWasmLogSink(speculative);
    return {
      ...s,
      route(line: string): "debug" | "error" {
        debug.mockClear();
        error.mockClear();
        s.printErr(line);
        return error.mock.calls.length === 0 ? "debug" : "error";
      },
    };
  }

  const START_GRAPH_FAILED =
    "E0825 10:14:04.401999 2196592 gl_graph_runner_internal.cc:255] StartGraph failed: " +
    "NOT_FOUND: Unable to open file at /model.dat; Initialize was not ok";

  it("swallows the probe's failure while the probe is in flight", () => {
    const s = sink(true);
    expect(s.route(START_GRAPH_FAILED)).toBe("debug");
    expect(s.route("Aborted(OOM)")).toBe("debug");
  });

  it("restores the level rule once the probe has settled", () => {
    const s = sink(true);
    s.settle();
    expect(s.route(START_GRAPH_FAILED)).toBe("error");
    expect(s.route("W0825 10:14:04.388000 2196592 gl_context.cc:1119] disabled")).toBe(
      "debug",
    );
  });

  it("never swallows anything on a non-speculative build", () => {
    // The CPU retry is the real load. If THAT cannot open the model, the user
    // has no hand tracking and the error has to survive.
    const s = sink(false);
    expect(s.route(START_GRAPH_FAILED)).toBe("error");
    s.settle();
    expect(s.route(START_GRAPH_FAILED)).toBe("error");
  });
});
