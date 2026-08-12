import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/core/config.js";
import { EventStore } from "../../src/core/event-store.js";
import type { ModelDescriptor } from "../../src/core/types.js";
import {
  AiSdkModelAdapter,
  type ModelAdapter,
  type ModelTurnInput,
} from "../../src/models/adapter.js";
import { ModelRegistry } from "../../src/models/registry.js";
import { RunEngine } from "../../src/runtime/run-engine.js";

const apiKeyEnv = "TMSH_RUN_ENGINE_AI_SDK_TEST_KEY";
const servers: Server[] = [];

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

describe("RunEngine with the AI SDK adapter", () => {
  it("owns three repaired parallel tool results without SDK duplicates", async () => {
    const requests: ChatRequest[] = [];
    const baseUrl = await chatServer(async (body, requestNumber) => {
      requests.push(body);
      return requestNumber === 1 ? threeToolResponse() : textResponse("done");
    });
    process.env[apiKeyEnv] = "local-test-key";
    const root = await mkdtemp(join(tmpdir(), "tmsh-engine-ai-sdk-"));
    const descriptor: ModelDescriptor = {
      id: "fixture.parallel-tools",
      provider: "openai-compatible",
      model: "fixture-model",
      apiKeyEnv,
      baseUrl,
      maxInputTokens: 100_000,
      maxOutputTokens: 1_000,
      supportsTools: true,
      supportsImages: false,
      capabilities: ["reasoning", "tool-use"],
    };
    const config = resolveConfig({
      dataDir: join(root, ".tmsh"),
      models: [descriptor],
      defaultModel: descriptor.id,
      autonomy: { mode: "yolo" },
    });
    const events = new EventStore(config.dataDir);
    const capturedInputs: ModelTurnInput[] = [];
    const baseAdapter = new AiSdkModelAdapter(descriptor);
    const adapter: ModelAdapter = {
      descriptor,
      complete: async (input) => {
        capturedInputs.push(structuredClone(input));
        return baseAdapter.complete(input);
      },
      summarize: (input) => baseAdapter.summarize(input),
    };
    const engine = new RunEngine(
      config,
      events,
      new ModelRegistry([descriptor], [adapter]),
      process.cwd(),
    );

    const runId = await engine.start({
      goal: "Run three independent observations",
      workspace: root,
      autonomy: "yolo",
    });

    const snapshot = await engine.wait(runId);
    expect(capturedInputs[1]?.messages).toMatchObject([
      { role: "user" },
      { role: "assistant" },
      {
        role: "tool",
        content: [{ toolCallId: "call-first" }],
      },
      {
        role: "tool",
        content: [{ toolCallId: "call-second" }],
      },
      {
        role: "tool",
        content: [{ toolCallId: "call-third" }],
      },
    ]);
    expect(snapshot).toMatchObject({
      status: "done",
      finalText: "done",
      modelCalls: 2,
    });
    expect(requests).toHaveLength(2);
    expect(
      requests[1]!.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id),
    ).toEqual(["call-first", "call-second", "call-third"]);
    expect(
      (await events.replay(runId)).filter(
        (event) => event.type === "tool.result",
      ),
    ).toHaveLength(3);
  });
});

interface ChatRequest {
  readonly messages: Array<{
    readonly role?: string;
    readonly tool_call_id?: string;
  }>;
}

interface FixtureResponse {
  readonly status: number;
  readonly body: unknown;
}

async function chatServer(
  handler: (
    body: ChatRequest,
    requestNumber: number,
  ) => Promise<FixtureResponse>,
): Promise<string> {
  let requestNumber = 0;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    requestNumber += 1;
    const fixture = await handler(
      JSON.parse(raw) as ChatRequest,
      requestNumber,
    );
    response.writeHead(fixture.status, { "content-type": "application/json" });
    response.end(JSON.stringify(fixture.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function threeToolResponse(): FixtureResponse {
  return {
    status: 200,
    body: {
      id: "chatcmpl-parallel-tools",
      object: "chat.completion",
      created: 1,
      model: "fixture-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "bounded fixture reasoning",
            tool_calls: ["first", "second", "third"].map((label) => ({
              id: `call-${label}`,
              type: "function",
              function: {
                name: "process_start",
                arguments: JSON.stringify({
                  file: process.execPath,
                  args: [
                    "-e",
                    `process.stdout.write(${JSON.stringify(label)})`,
                  ],
                  background: false,
                }),
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
      id: "chatcmpl-text",
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
