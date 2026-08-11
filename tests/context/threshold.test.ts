import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/core/config.js";
import {
  calculateThresholds,
  decideCompaction,
} from "../../src/context/threshold.js";

describe("compaction thresholds", () => {
  it("uses an absolute soft trigger before the ratio", () => {
    const config = resolveConfig({
      compaction: { triggerTokens: 60_000, reservedOutputTokens: 10_000 },
    });
    expect(calculateThresholds(config.compaction, 110_000, 20_000)).toEqual({
      capacityKnown: true,
      reservedOutputTokens: 10_000,
      usableInputTokens: 100_000,
      softTriggerTokens: 60_000,
      hardTriggerTokens: 90_000,
    });
  });

  it("offers at soft and requires compaction at hard including pending tokens", () => {
    const config = resolveConfig({ compaction: { reservedOutputTokens: 0 } });
    expect(
      decideCompaction({
        config: config.compaction,
        maxInputTokens: 100_000,
        observedInputTokens: 75_000,
      }).reason,
    ).toBe("soft_trigger");
    expect(
      decideCompaction({
        config: config.compaction,
        maxInputTokens: 100_000,
        observedInputTokens: 89_000,
        pendingEstimatedTokens: 1_000,
      }).reason,
    ).toBe("hard_trigger");
  });

  it("does not invent a ratio threshold for unknown model capacity", () => {
    const config = resolveConfig();
    expect(
      decideCompaction({
        config: config.compaction,
        observedInputTokens: 999_999,
      }),
    ).toMatchObject({ action: "skip", reason: "unknown_model_capacity" });
  });

  it("allows a model-requested early compaction but respects off mode", () => {
    const auto = resolveConfig();
    expect(
      decideCompaction({
        config: auto.compaction,
        observedInputTokens: 1,
        modelRequested: true,
      }).reason,
    ).toBe("model_requested");
    const off = resolveConfig({ compaction: { mode: "off" } });
    expect(
      decideCompaction({
        config: off.compaction,
        observedInputTokens: 1,
        modelRequested: true,
      }).reason,
    ).toBe("disabled");
  });

  it("fails closed when an absolute soft trigger crosses hard", () => {
    const config = resolveConfig({
      compaction: { triggerTokens: 95_000, reservedOutputTokens: 0 },
    });
    expect(() =>
      calculateThresholds(config.compaction, 100_000, undefined),
    ).toThrow(/below the hard/);
  });
});
