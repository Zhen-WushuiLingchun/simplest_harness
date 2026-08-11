import type { ModelDescriptor } from "../core/types.js";
import { AiSdkModelAdapter, type ModelAdapter } from "./adapter.js";

export interface ModelAvailability {
  readonly descriptor: ModelDescriptor;
  readonly available: boolean;
  readonly reason?: string;
}

export class ModelRegistry {
  readonly #descriptors = new Map<string, ModelDescriptor>();
  readonly #adapters = new Map<string, ModelAdapter>();

  public constructor(
    descriptors: readonly ModelDescriptor[],
    adapters: readonly ModelAdapter[] = [],
  ) {
    for (const descriptor of descriptors) {
      if (this.#descriptors.has(descriptor.id))
        throw new Error(`duplicate model id: ${descriptor.id}`);
      this.#descriptors.set(descriptor.id, descriptor);
    }
    for (const adapter of adapters) {
      const descriptor = this.#descriptors.get(adapter.descriptor.id);
      if (descriptor === undefined)
        throw new Error(
          `adapter model is not registered: ${adapter.descriptor.id}`,
        );
      this.#adapters.set(adapter.descriptor.id, adapter);
    }
  }

  public list(): ModelAvailability[] {
    return [...this.#descriptors.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((descriptor) =>
        availability(descriptor, this.#adapters.has(descriptor.id)),
      );
  }

  public get(id: string): ModelAdapter {
    const injected = this.#adapters.get(id);
    if (injected !== undefined) return injected;
    const descriptor = this.#descriptors.get(id);
    if (descriptor === undefined) throw new Error(`unknown model: ${id}`);
    const state = availability(descriptor, false);
    if (!state.available) throw new Error(state.reason);
    const adapter = new AiSdkModelAdapter(descriptor);
    this.#adapters.set(id, adapter);
    return adapter;
  }

  public descriptor(id: string): ModelDescriptor {
    const descriptor = this.#descriptors.get(id);
    if (descriptor === undefined) throw new Error(`unknown model: ${id}`);
    return descriptor;
  }
}

function availability(
  descriptor: ModelDescriptor,
  injected: boolean,
): ModelAvailability {
  if (injected) return { descriptor, available: true };
  if (descriptor.provider === "fake")
    return {
      descriptor,
      available: false,
      reason: "fake model needs an injected adapter",
    };
  if (descriptor.apiKeyEnv === undefined)
    return {
      descriptor,
      available: false,
      reason: "apiKeyEnv is not configured",
    };
  if (!process.env[descriptor.apiKeyEnv]) {
    return {
      descriptor,
      available: false,
      reason: `missing environment variable: ${descriptor.apiKeyEnv}`,
    };
  }
  if (
    descriptor.provider === "openai-compatible" &&
    descriptor.baseUrl === undefined
  ) {
    return {
      descriptor,
      available: false,
      reason: "openai-compatible model requires baseUrl",
    };
  }
  return { descriptor, available: true };
}
