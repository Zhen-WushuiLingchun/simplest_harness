import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelDescriptor } from "../../src/core/types.js";
import type { ToolSummary } from "../../src/core/tool-registry.js";
import { AiSdkModelAdapter } from "../../src/models/adapter.js";

const servers: Server[] = [];
const apiKeyEnv = "TMSH_ADAPTER_COMPATIBILITY_TEST_KEY";

afterEach(async () => {
  delete process.env[apiKeyEnv];
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        }),
    ),
  );
});

describe("AI SDK provider compatibility", () => {
  it("replays reasoning and matched parallel tool results", async () => {
    const bodies: ChatRequest[] = [];
    const baseUrl = await chatServer(async (body, responseNumber) => {
      bodies.push(body);
      return responseNumber === 1
        ? toolResponse({
            reasoning: "private provider reasoning that must be replayed",
            calls: [
              {
                id: "call-first",
                arguments: JSON.stringify({ file: "pwd" }),
              },
              {
                id: "call-second",
                arguments: JSON.stringify({ file: "ls", args: ["-la"] }),
              },
            ],
          })
        : textResponse("ok");
    });
    const adapter = fixtureAdapter(baseUrl);
    const initial: ModelMessage[] = [{ role: "user", content: "inspect" }];
    const first = await adapter.complete(turn(initial));
    const history: ModelMessage[] = [...initial, ...first.responseMessages];
    for (const call of first.toolCalls) {
      history.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: call.id,
            toolName: call.providerName ?? call.name,
            output: { type: "json", value: { ok: true } },
          },
        ],
      });
    }

    await expect(adapter.complete(turn(history))).resolves.toMatchObject({
      finishReason: "stop",
      text: "ok",
    });
    const replay = bodies[1]!.messages;
    expect(replay[2]).toMatchObject({
      role: "assistant",
      reasoning_content: "private provider reasoning that must be replayed",
      tool_calls: [{ id: "call-first" }, { id: "call-second" }],
    });
    expect(replay.slice(3)).toMatchObject([
      { role: "tool", tool_call_id: "call-first" },
      { role: "tool", tool_call_id: "call-second" },
    ]);
  });

  it("repairs a provider tool object that remains encoded after parsing", async () => {
    const baseUrl = await chatServer(async () =>
      toolResponse({
        calls: [
          {
            id: "call-encoded",
            arguments: JSON.stringify(JSON.stringify({ file: "pwd" })),
          },
        ],
      }),
    );
    const adapter = fixtureAdapter(baseUrl);

    const result = await adapter.complete(
      turn([{ role: "user", content: "inspect" }]),
    );

    expect(result.toolCalls[0]?.input).toEqual({ file: "pwd" });
    expect(result.responseMessages[0]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-encoded",
          input: { file: "pwd" },
        },
      ],
    });
  });

  it("does not replay SDK tool errors for a uniquely repairable name", async () => {
    const baseUrl = await chatServer(async () =>
      toolResponse({
        calls: [
          {
            id: "call-invalid-input",
            name: "process_start",
            arguments: JSON.stringify({ file: "pwd" }),
          },
        ],
      }),
    );
    const adapter = fixtureAdapter(baseUrl);

    const result = await adapter.complete(
      turn([{ role: "user", content: "inspect" }]),
    );

    expect(result.toolCalls).toMatchObject([
      {
        id: "call-invalid-input",
        name: "process.start",
        providerName: "process_start_6f0b1c6ff5",
        input: { file: "pwd" },
      },
    ]);
    expect(result.responseMessages.map((message) => message.role)).toEqual([
      "assistant",
    ]);
  });

  it.each([
    {
      label: "orphan result",
      messages: [
        { role: "user", content: "inspect" },
        {
          role: "tool",
          content: [toolResult("orphan")],
        },
      ] satisfies ModelMessage[],
      expected: /orphan tool result/u,
    },
    {
      label: "duplicate call id",
      messages: [
        { role: "user", content: "inspect" },
        assistantCall("duplicate"),
        { role: "tool", content: [toolResult("duplicate")] },
        assistantCall("duplicate"),
        { role: "tool", content: [toolResult("duplicate")] },
      ] satisfies ModelMessage[],
      expected: /duplicate tool call id/u,
    },
    {
      label: "unresolved call",
      messages: [
        { role: "user", content: "inspect" },
        assistantCall("pending"),
        { role: "user", content: "overtook the tool" },
      ] satisfies ModelMessage[],
      expected: /unresolved tool calls/u,
    },
  ])("rejects $label before network I/O", async ({ messages, expected }) => {
    let requests = 0;
    const baseUrl = await chatServer(async () => {
      requests += 1;
      return textResponse("should not be reached");
    });
    const adapter = fixtureAdapter(baseUrl);

    await expect(adapter.complete(turn(messages))).rejects.toThrow(expected);
    expect(requests).toBe(0);
  });

  it("classifies a known OpenCode tool-history rejection without retrying", async () => {
    let requests = 0;
    const baseUrl = await chatServer(async () => {
      requests += 1;
      return {
        status: 400,
        body: {
          error: {
            type: "invalid_request_error",
            code: "invalid_request_error",
            message:
              "Error from provider (Console Go): Upstream request failed: [invalid_request_error] Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
          },
        },
      };
    });
    const adapter = fixtureAdapter(baseUrl, [
      "reasoning",
      "tool-use",
      "opencode-go-chat-completions",
    ]);

    await expect(
      adapter.complete(turn([{ role: "user", content: "inspect" }])),
    ).rejects.toThrow(
      /OpenCode Go compatibility error.*request was not retried.*Messages with role 'tool'/u,
    );
    expect(requests).toBe(1);
  });
});

interface ChatRequest {
  readonly messages: Array<Record<string, unknown>>;
}

interface FixtureResponse {
  readonly status: number;
  readonly body: unknown;
}

async function chatServer(
  handler: (
    body: ChatRequest,
    responseNumber: number,
  ) => Promise<FixtureResponse>,
): Promise<string> {
  let responseNumber = 0;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    responseNumber += 1;
    const fixture = await handler(
      JSON.parse(raw) as ChatRequest,
      responseNumber,
    );
    response.writeHead(fixture.status, { "content-type": "application/json" });
    response.end(JSON.stringify(fixture.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function fixtureAdapter(
  baseUrl: string,
  capabilities: readonly string[] = ["reasoning", "tool-use"],
): AiSdkModelAdapter {
  process.env[apiKeyEnv] = "local-test-key";
  const descriptor: ModelDescriptor = {
    id: "fixture.model",
    provider: "openai-compatible",
    model: "fixture-model",
    apiKeyEnv,
    baseUrl,
    maxInputTokens: 100_000,
    maxOutputTokens: 1_000,
    supportsTools: true,
    supportsImages: false,
    capabilities,
  };
  return new AiSdkModelAdapter(descriptor);
}

function turn(messages: readonly ModelMessage[]) {
  return {
    system: "bounded compatibility fixture",
    messages,
    tools: [processTool],
    signal: new AbortController().signal,
    maxOutputTokens: 1_000,
  };
}

const processTool: ToolSummary = {
  name: "process.start",
  description: "Start a process.",
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string" },
      args: { type: "array", items: { type: "string" } },
    },
    required: ["file"],
    additionalProperties: false,
  },
  effect: "write",
};

function assistantCall(toolCallId: string): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId,
        toolName: "process_start_6f0b1c6ff5",
        input: { file: "pwd" },
      },
    ],
  };
}

function toolResult(toolCallId: string) {
  return {
    type: "tool-result" as const,
    toolCallId,
    toolName: "process_start_6f0b1c6ff5",
    output: { type: "json" as const, value: { ok: true } },
  };
}

function toolResponse(input: {
  readonly reasoning?: string;
  readonly calls: readonly {
    readonly id: string;
    readonly name?: string;
    readonly arguments: string;
  }[];
}): FixtureResponse {
  return {
    status: 200,
    body: {
      id: "chatcmpl-fixture-tool",
      object: "chat.completion",
      created: 1,
      model: "fixture-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            ...(input.reasoning === undefined
              ? {}
              : { reasoning_content: input.reasoning }),
            tool_calls: input.calls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name ?? "process_start_6f0b1c6ff5",
                arguments: call.arguments,
              },
            })),
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    },
  };
}

function textResponse(text: string): FixtureResponse {
  return {
    status: 200,
    body: {
      id: "chatcmpl-fixture-text",
      object: "chat.completion",
      created: 2,
      model: "fixture-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
    },
  };
}
