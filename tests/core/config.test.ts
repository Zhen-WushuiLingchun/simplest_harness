import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "../../src/core/config.js";

describe("resolveConfig", () => {
  it("uses conservative local-first defaults", () => {
    const config = resolveConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.compaction.triggerRatio).toBe(0.75);
    expect(config.compaction.hardRatio).toBe(0.9);
    expect(config.host).toBe("127.0.0.1");
    expect(config.autonomy.mode).toBe("confirm");
  });

  it("merges nested user overrides without erasing sibling defaults", () => {
    const config = resolveConfig({
      compaction: { triggerTokens: 120_000 },
      process: { defaultYieldMs: 250 },
    });
    expect(config.compaction.triggerTokens).toBe(120_000);
    expect(config.compaction.triggerRatio).toBe(0.75);
    expect(config.process.defaultYieldMs).toBe(250);
    expect(config.process.defaultTimeoutMs).toBe(
      DEFAULT_CONFIG.process.defaultTimeoutMs,
    );
  });

  it("rejects remote binding and invalid threshold ordering", () => {
    expect(() => resolveConfig({ host: "0.0.0.0" })).toThrow(/loopback/);
    expect(() =>
      resolveConfig({ compaction: { triggerRatio: 0.9, hardRatio: 0.8 } }),
    ).toThrow(/hardRatio/);
  });

  it("requires the default model to be registered", () => {
    expect(() => resolveConfig({ defaultModel: "missing" })).toThrow(
      /not registered/,
    );
  });

  it("supports an explicit yolo autonomy mode", () => {
    const config = resolveConfig({ autonomy: { mode: "yolo" } });
    expect(config.autonomy.mode).toBe("yolo");
  });

  it("allows a separately registered compaction model", () => {
    const model = {
      id: "deepseek.compactor",
      provider: "openai-compatible" as const,
      model: "deepseek-chat",
      baseUrl: "https://example.invalid/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      supportsTools: true,
      supportsImages: false,
      capabilities: ["summarization"],
    };
    expect(
      resolveConfig({ models: [model], compaction: { modelId: model.id } })
        .compaction.modelId,
    ).toBe(model.id);
    expect(() => resolveConfig({ compaction: { modelId: "missing" } })).toThrow(
      /compaction model/,
    );
  });
});
