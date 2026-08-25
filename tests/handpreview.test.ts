import { describe, expect, it } from "vitest";
import { MAX_SPARKS, SPARK_TUNING } from "../src/content/renderer/sparks";
import {
  LEAD_LIFE,
  LEAD_RATE_FRACTION,
  SPARK_MEAN_LIFE,
  TRAIL_LIFE,
  TRAIL_RATE,
} from "../src/content/handpreview";

/**
 * Particle budget.
 *
 * A population of `rate * meanLife * lifeScale` sits alive at steady state. If
 * the total exceeds MAX_SPARKS the recycler begins overwriting particles that
 * have not expired, and the result is a thin, flickering trail that looks like
 * a rate problem and cannot be fixed by changing rates. This has already
 * happened once in this project, which is why it is pinned here.
 */

const steady = (rate: number, lifeScale: number) => rate * SPARK_MEAN_LIFE * lifeScale;

describe("hand preview particle budget", () => {
  const lead = steady(SPARK_TUNING.rateIgnite * LEAD_RATE_FRACTION, LEAD_LIFE);
  const trail = steady(TRAIL_RATE, TRAIL_LIFE);

  it("stays clear of the ceiling with room to spare", () => {
    const total = lead + trail;
    expect(total).toBeLessThan(MAX_SPARKS);
    // Headroom, not a bare pass: strokes vary and the whip population skews
    // lifetimes upward.
    expect(total / MAX_SPARKS, `using ${Math.round(total)} of ${MAX_SPARKS}`)
      .toBeLessThan(0.85);
  });

  it("keeps the trail alive long enough to outlast a stroke", () => {
    // A deliberate circle in the air takes well over a second; the drawn arc
    // has to still be there when it closes.
    const shortestTrailEmber = 0.4 * TRAIL_LIFE;
    expect(shortestTrailEmber).toBeGreaterThan(2.0);
  });

  it("keeps the leading spray short-lived relative to the trail", () => {
    // The tip throws sparks away; the trail rests on the arc. If the tip's
    // embers lived as long, the whole screen would fill with drifting sparks
    // and the drawn arc would stop being readable.
    expect(LEAD_LIFE).toBeLessThan(TRAIL_LIFE / 2);
  });
});
