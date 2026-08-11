import { describe, expect, it } from "vitest";
import {
  FakeModelAdapter,
  type ModelTurnOutput,
} from "../../src/models/adapter.js";
import { ModelRegistry } from "../../src/models/registry.js";
import type { ModelDescriptor } from "../../src/core/types.js";

const descriptor: ModelDescriptor = {
  id: "fake.fast",
  provider: "fake",
  model: "deterministic",
  supportsTools: true,
  supportsImages: false,
  capabilities: ["tests"],
};

const turn: ModelTurnOutput = {
  text: "done",
  responseMessages: [{ role: "assistant", content: "done" }],
  toolCalls: [],
  usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, estimated: false },
  finishReason: "stop",
};

describe("ModelRegistry", () => {
  it("exposes capabilities and injected fake availability without credentials", () => {
    const adapter = new FakeModelAdapter(descriptor, [turn]);
    const registry = new ModelRegistry([descriptor], [adapter]);
    expect(registry.list()).toEqual([{ descriptor, available: true }]);
    expect(registry.get(descriptor.id)).toBe(adapter);
  });

  it("reports missing credential environment variables without reading them into the descriptor", () => {
    const openai: ModelDescriptor = {
      ...descriptor,
      id: "openai.main",
      provider: "openai",
      model: "gpt-test",
      apiKeyEnv: "TMSH_TEST_MISSING_KEY",
    };
    const state = new ModelRegistry([openai]).list()[0]!;
    expect(state.available).toBe(false);
    expect(state.reason).toContain("TMSH_TEST_MISSING_KEY");
    expect(JSON.stringify(state)).not.toContain("sk-");
  });

  it("hot-registers a model added by the local API wizard", () => {
    process.env.TMSH_HOT_KEY = "test-only";
    try {
      const registry = new ModelRegistry([]);
      registry.upsert({
        id: "hot.model",
        provider: "openai-compatible",
        model: "hot-model",
        apiKeyEnv: "TMSH_HOT_KEY",
        baseUrl: "https://example.invalid/v1",
        supportsTools: true,
        supportsImages: false,
        capabilities: ["discovered"],
      });
      expect(registry.list()).toMatchObject([
        { descriptor: { id: "hot.model" }, available: true },
      ]);
    } finally {
      delete process.env.TMSH_HOT_KEY;
    }
  });
});
