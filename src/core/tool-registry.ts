import type { JsonValue } from "./types.js";

export interface ToolContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly eventId?: string;
}

export type ToolEffect = "read" | "write" | "external";

export interface ToolDefinition<
  TInput = JsonValue,
  TOutput extends JsonValue = JsonValue,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, JsonValue>;
  readonly effect?: ToolEffect;
  readonly execute: (input: TInput, context: ToolContext) => Promise<TOutput>;
}

export interface ToolSummary {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, JsonValue>;
  readonly effect: ToolEffect;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  public register(tool: ToolDefinition): void {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
      throw new Error(`invalid tool name: ${tool.name}`);
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`duplicate tool: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  public list(): ToolSummary[] {
    return [...this.#tools.values()]
      .map(({ name, description, inputSchema, effect = "write" }) => ({
        name,
        description,
        inputSchema,
        effect,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  public async call(
    name: string,
    input: JsonValue,
    context: ToolContext,
  ): Promise<JsonValue> {
    const tool = this.#tools.get(name);
    if (tool === undefined) throw new Error(`unknown tool: ${name}`);
    return tool.execute(input, context);
  }
}
