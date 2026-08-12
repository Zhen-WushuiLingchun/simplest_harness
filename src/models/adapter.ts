import {
  Output,
  dynamicTool,
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { JsonValue, ModelDescriptor, TokenUsage } from "../core/types.js";
import type { ToolSummary } from "../core/tool-registry.js";
import { retracSummarySchema, type RetracSummary } from "../context/schema.js";
import { canonicalJson } from "../context/canonical.js";
import { createHash } from "node:crypto";

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly providerName?: string;
  readonly input: JsonValue;
}

export interface ModelTurnInput {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSummary[];
  readonly signal: AbortSignal;
  readonly maxOutputTokens?: number;
}

export interface ModelTurnOutput {
  readonly text: string;
  readonly responseMessages: readonly ModelMessage[];
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage: TokenUsage;
  readonly finishReason: string;
}

export interface SummaryInput {
  readonly messages: readonly JsonValue[];
  readonly system: string;
  readonly signal: AbortSignal;
  readonly maxOutputTokens?: number;
}

export interface ModelAdapter {
  readonly descriptor: ModelDescriptor;
  complete(input: ModelTurnInput): Promise<ModelTurnOutput>;
  summarize(input: SummaryInput): Promise<RetracSummary>;
}

export class AiSdkModelAdapter implements ModelAdapter {
  public readonly descriptor: ModelDescriptor;
  readonly #model: LanguageModel;

  public constructor(
    descriptor: ModelDescriptor,
    model = createLanguageModel(descriptor),
  ) {
    this.descriptor = descriptor;
    this.#model = model;
  }

  public async complete(input: ModelTurnInput): Promise<ModelTurnOutput> {
    assertValidToolHistory(input.messages);
    const aliases = toolAliases(input.tools);
    const tools = Object.fromEntries(
      input.tools.map((item) => {
        const alias = aliases.canonicalToProvider.get(item.name)!;
        return [
          alias,
          dynamicTool({
            description: `Canonical TMSH tool: ${item.name}. ${item.description}`,
            inputSchema: jsonSchema(item.inputSchema),
          }),
        ];
      }),
    );
    const result = await generateText({
      model: this.#model,
      system: input.system,
      messages: [...input.messages],
      tools,
      repairToolCall: async ({ toolCall }) => {
        const repairedInput = repairDoubleEncodedToolInput(toolCall.input);
        return repairedInput === undefined
          ? null
          : { ...toolCall, input: repairedInput };
      },
      abortSignal: input.signal,
      ...(input.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.maxOutputTokens }),
    }).catch((error: unknown) => {
      throw classifyProviderError(this.descriptor, error);
    });
    const toolCalls = result.toolCalls.map((call) => {
      const resolved = resolveProviderToolName(call.toolName, aliases);
      return {
        id: call.toolCallId,
        name: resolved.canonicalName,
        providerName: resolved.providerName,
        input: normalizeParsedToolInput(call.input),
      };
    });
    return {
      text: result.text,
      responseMessages: normalizeResponseToolNames(
        // AI SDK appends tool-role error messages when it cannot validate a
        // provider tool call. RunEngine is the sole executor and result owner,
        // including unknown/invalid calls, so replaying those SDK-generated
        // results would duplicate the same toolCallId on the next turn.
        result.response.messages.filter(
          (message) => message.role === "assistant",
        ),
        toolCalls,
      ),
      toolCalls,
      usage: {
        ...(result.usage.inputTokens === undefined
          ? {}
          : { inputTokens: result.usage.inputTokens }),
        ...(result.usage.outputTokens === undefined
          ? {}
          : { outputTokens: result.usage.outputTokens }),
        ...(result.usage.totalTokens === undefined
          ? {}
          : { totalTokens: result.usage.totalTokens }),
        estimated: false,
      },
      finishReason: result.finishReason,
    };
  }

  public async summarize(input: SummaryInput): Promise<RetracSummary> {
    const result = await generateText({
      model: this.#model,
      system: `${input.system}\n\nYou are producing only the lossy RE-TRAC narrative layer. Exact ledger records are attached and validated by the runtime. Preserve negative results in failedAttempts and incomplete work in unfinishedBranches.`,
      prompt: `Compress this message history into conclusions, evidence, openQuestions, failedAttempts, unfinishedBranches, and discardedPossibilities. Do not claim facts absent from the history.\n\n${canonicalJson(input.messages as JsonValue)}`,
      output: Output.object({
        schema: retracSummarySchema,
        name: "retrac_summary",
      }),
      abortSignal: input.signal,
      ...(input.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.maxOutputTokens }),
    });
    return result.output;
  }
}

export class FakeModelAdapter implements ModelAdapter {
  public readonly descriptor: ModelDescriptor;
  public readonly inputs: ModelTurnInput[] = [];
  readonly #turns: ModelTurnOutput[];
  readonly #summary: RetracSummary;

  public constructor(
    descriptor: ModelDescriptor,
    turns: readonly ModelTurnOutput[],
    summary?: RetracSummary,
  ) {
    this.descriptor = descriptor;
    this.#turns = [...turns];
    this.#summary = summary ?? {
      conclusions: [],
      evidence: [],
      openQuestions: [],
      failedAttempts: [],
      unfinishedBranches: [],
      discardedPossibilities: [],
    };
  }

  public async complete(input: ModelTurnInput): Promise<ModelTurnOutput> {
    this.inputs.push(input);
    const turn = this.#turns.shift();
    if (turn === undefined)
      throw new Error(`fake model has no queued turn: ${this.descriptor.id}`);
    return turn;
  }

  public async summarize(_input: SummaryInput): Promise<RetracSummary> {
    return this.#summary;
  }
}

function createLanguageModel(descriptor: ModelDescriptor): LanguageModel {
  if (descriptor.provider === "fake")
    throw new Error("fake models require an injected adapter");
  const apiKey = readApiKey(descriptor);
  if (descriptor.provider === "openai") {
    const provider = createOpenAI({
      apiKey,
      ...(descriptor.baseUrl === undefined
        ? {}
        : { baseURL: descriptor.baseUrl }),
    });
    return provider(descriptor.model);
  }
  if (descriptor.provider === "anthropic") {
    const provider = createAnthropic({
      apiKey,
      ...(descriptor.baseUrl === undefined
        ? {}
        : { baseURL: descriptor.baseUrl }),
    });
    return provider(descriptor.model);
  }
  if (descriptor.baseUrl === undefined)
    throw new Error(
      `openai-compatible model requires baseUrl: ${descriptor.id}`,
    );
  const provider = createOpenAICompatible({
    name: descriptor.id,
    apiKey,
    baseURL: descriptor.baseUrl,
  });
  return provider(descriptor.model);
}

function readApiKey(descriptor: ModelDescriptor): string {
  if (descriptor.apiKeyEnv === undefined)
    throw new Error(`model requires apiKeyEnv: ${descriptor.id}`);
  const value = process.env[descriptor.apiKeyEnv];
  if (value === undefined || value.length === 0)
    throw new Error(
      `model API key environment variable is missing: ${descriptor.apiKeyEnv}`,
    );
  return value;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * Dynamic tools can expose a JSON object as a string after the provider layer
 * has already parsed a double-encoded arguments field. Decode only that exact,
 * lossless shape; tool inputs are objects, so arrays and scalar JSON remain
 * untouched and fail through the normal tool boundary.
 */
export function normalizeParsedToolInput(input: unknown): JsonValue {
  if (typeof input === "string") {
    try {
      const decoded: unknown = JSON.parse(input);
      if (
        decoded !== null &&
        typeof decoded === "object" &&
        !Array.isArray(decoded)
      ) {
        return toJsonValue(decoded);
      }
    } catch {
      // The original string is retained for normal tool-schema rejection.
    }
  }
  return toJsonValue(input);
}

/**
 * Some OpenAI-compatible gateways occasionally JSON-encode an already encoded
 * tool argument object. AI SDK then sees a JSON string where the tool schema
 * requires an object. Repair only that narrow, lossless shape and leave every
 * other invalid input to normal schema validation.
 */
export function repairDoubleEncodedToolInput(
  input: string,
): string | undefined {
  try {
    const once: unknown = JSON.parse(input);
    if (typeof once !== "string") return undefined;
    const twice: unknown = JSON.parse(once);
    if (twice === null || typeof twice !== "object") return undefined;
    return JSON.stringify(twice);
  } catch {
    return undefined;
  }
}

export function resolveProviderToolName(
  providerName: string,
  aliases: ReturnType<typeof toolAliases>,
): { readonly canonicalName: string; readonly providerName: string } {
  const exact = aliases.providerToCanonical.get(providerName);
  if (exact !== undefined) return { canonicalName: exact, providerName };

  const matches = [...aliases.canonicalToProvider.entries()].filter(
    ([, alias]) => alias.slice(0, alias.lastIndexOf("_")) === providerName,
  );
  if (matches.length !== 1)
    return { canonicalName: providerName, providerName };
  return { canonicalName: matches[0]![0], providerName: matches[0]![1] };
}

function normalizeResponseToolNames(
  messages: readonly ModelMessage[],
  calls: readonly ModelToolCall[],
): ModelMessage[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  return messages.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string")
      return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-call") return part;
        const call = byId.get(part.toolCallId);
        return call === undefined
          ? part
          : {
              ...part,
              toolName: call.providerName ?? call.name,
              input: call.input,
            };
      }),
    };
  });
}

/**
 * Validate the standard assistant tool-call -> tool-result contract before a
 * provider sees the history. This catches local corruption without spending a
 * request and makes a later provider rejection attributable to the provider
 * compatibility boundary rather than an unchecked TMSH message sequence.
 */
export function assertValidToolHistory(
  messages: readonly ModelMessage[],
): void {
  const seenCalls = new Set<string>();
  const seenResults = new Set<string>();
  const pending = new Set<string>();

  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      assertNoPendingBeforeMessage(pending, index, message.role);
      if (typeof message.content === "string") continue;
      for (const part of message.content) {
        if (part.type !== "tool-call") continue;
        if (seenCalls.has(part.toolCallId)) {
          throw new Error(
            `invalid model message history: duplicate tool call id ${part.toolCallId} at message[${index}]`,
          );
        }
        seenCalls.add(part.toolCallId);
        pending.add(part.toolCallId);
      }
      continue;
    }

    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        if (seenResults.has(part.toolCallId)) {
          throw new Error(
            `invalid model message history: duplicate tool result id ${part.toolCallId} at message[${index}]`,
          );
        }
        if (!pending.has(part.toolCallId)) {
          throw new Error(
            `invalid model message history: orphan tool result ${part.toolCallId} at message[${index}]`,
          );
        }
        seenResults.add(part.toolCallId);
        pending.delete(part.toolCallId);
      }
      continue;
    }

    assertNoPendingBeforeMessage(pending, index, message.role);
  }

  if (pending.size > 0) {
    throw new Error(
      `invalid model message history: unresolved tool calls at end of history: ${[...pending].join(", ")}`,
    );
  }
}

function assertNoPendingBeforeMessage(
  pending: ReadonlySet<string>,
  index: number,
  role: string,
): void {
  if (pending.size === 0) return;
  throw new Error(
    `invalid model message history: unresolved tool calls before ${role} message[${index}]: ${[...pending].join(", ")}`,
  );
}

function classifyProviderError(
  descriptor: ModelDescriptor,
  error: unknown,
): unknown {
  if (!descriptor.capabilities.includes("opencode-go-chat-completions"))
    return error;
  const message = error instanceof Error ? error.message : String(error);
  const knownHistoryRejection = [
    "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
    "Duplicate value for 'tool_call_id'",
    "The `reasoning_content` in the thinking mode must be passed back to the API",
  ].some((fragment) => message.includes(fragment));
  if (!knownHistoryRejection) return error;
  return new Error(
    `OpenCode Go compatibility error: provider rejected tool-call history after TMSH structural validation; request was not retried. ${message}`,
    { cause: error },
  );
}

export function toolAliases(tools: readonly ToolSummary[]): {
  readonly canonicalToProvider: ReadonlyMap<string, string>;
  readonly providerToCanonical: ReadonlyMap<string, string>;
} {
  const canonicalToProvider = new Map<string, string>();
  const providerToCanonical = new Map<string, string>();
  for (const tool of tools) {
    const readable =
      tool.name.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 48) || "tool";
    const suffix = createHash("sha256")
      .update(tool.name, "utf8")
      .digest("hex")
      .slice(0, 10);
    const alias = `${readable}_${suffix}`;
    canonicalToProvider.set(tool.name, alias);
    providerToCanonical.set(alias, tool.name);
  }
  return { canonicalToProvider, providerToCanonical };
}
