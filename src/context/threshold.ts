import type { CompactionConfig } from "../core/config.js";

export interface CompactionThresholds {
  readonly capacityKnown: boolean;
  readonly reservedOutputTokens: number;
  readonly usableInputTokens?: number;
  readonly softTriggerTokens?: number;
  readonly hardTriggerTokens?: number;
}

export type CompactionAction = "continue" | "offer" | "compact" | "skip";

export interface CompactionDecision extends CompactionThresholds {
  readonly action: CompactionAction;
  readonly reason:
    | "disabled"
    | "manual_mode"
    | "unknown_model_capacity"
    | "below_soft_trigger"
    | "model_requested"
    | "soft_trigger"
    | "hard_trigger";
}

export function calculateThresholds(
  config: CompactionConfig,
  maxInputTokens: number | undefined,
  modelMaxOutputTokens: number | undefined,
): CompactionThresholds {
  const reservedOutputTokens =
    config.reservedOutputTokens ?? modelMaxOutputTokens ?? 4_096;
  if (!Number.isInteger(reservedOutputTokens) || reservedOutputTokens < 0) {
    throw new Error("reserved output tokens must be a non-negative integer");
  }
  if (maxInputTokens === undefined)
    return { capacityKnown: false, reservedOutputTokens };
  if (
    !Number.isInteger(maxInputTokens) ||
    maxInputTokens <= reservedOutputTokens
  ) {
    throw new Error("model input capacity must exceed reserved output tokens");
  }

  const usableInputTokens = maxInputTokens - reservedOutputTokens;
  const softTriggerTokens =
    config.triggerTokens ?? Math.floor(usableInputTokens * config.triggerRatio);
  const hardTriggerTokens = Math.floor(usableInputTokens * config.hardRatio);
  if (
    !Number.isInteger(softTriggerTokens) ||
    softTriggerTokens <= 0 ||
    softTriggerTokens >= hardTriggerTokens
  ) {
    throw new Error(
      "soft compaction trigger must be positive and below the hard trigger",
    );
  }
  return {
    capacityKnown: true,
    reservedOutputTokens,
    usableInputTokens,
    softTriggerTokens,
    hardTriggerTokens,
  };
}

export function decideCompaction(input: {
  readonly config: CompactionConfig;
  readonly maxInputTokens?: number;
  readonly modelMaxOutputTokens?: number;
  readonly observedInputTokens: number;
  readonly pendingEstimatedTokens?: number;
  readonly modelRequested?: boolean;
}): CompactionDecision {
  const thresholds = calculateThresholds(
    input.config,
    input.maxInputTokens,
    input.modelMaxOutputTokens,
  );
  if (input.config.mode === "off")
    return { ...thresholds, action: "skip", reason: "disabled" };
  if (input.modelRequested && input.config.allowModelEarly) {
    return { ...thresholds, action: "compact", reason: "model_requested" };
  }
  if (input.config.mode === "manual")
    return { ...thresholds, action: "continue", reason: "manual_mode" };
  if (!thresholds.capacityKnown) {
    return { ...thresholds, action: "skip", reason: "unknown_model_capacity" };
  }
  const projected =
    input.observedInputTokens + (input.pendingEstimatedTokens ?? 0);
  if (projected >= thresholds.hardTriggerTokens!) {
    return { ...thresholds, action: "compact", reason: "hard_trigger" };
  }
  if (projected >= thresholds.softTriggerTokens!) {
    return { ...thresholds, action: "offer", reason: "soft_trigger" };
  }
  return { ...thresholds, action: "continue", reason: "below_soft_trigger" };
}
