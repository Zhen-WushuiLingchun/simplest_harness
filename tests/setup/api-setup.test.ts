import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  descriptorProvider,
  discoverProviderModels,
  providerDefaultBaseUrl,
  saveApiConnection,
} from "../../src/setup/api-setup.js";
import {
  loadLocalEnvironment,
  parseLocalEnvironment,
} from "../../src/setup/local-env.js";
import { runApiSetupWizard } from "../../src/setup/wizard.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) =>
              error === undefined ? resolve() : reject(error),
            ),
          ),
      ),
  );
  delete process.env.TMSH_LAB_API_KEY;
  delete process.env.TMSH_WIZARD_API_KEY;
  delete process.env.TMSH_OPENCODE_GO_API_KEY;
});

describe("local API setup", () => {
  it("discovers provider models and persists descriptors separately from the secret", async () => {
    const secret = "test-secret-never-in-config";
    const server = createServer((request, response) => {
      expect(request.url).toBe("/v1/models");
      expect(request.headers.authorization).toBe(`Bearer ${secret}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [{ id: "model-z" }, { id: "model-a" }, { id: "model-a" }],
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("test server has no TCP address");
    const setup = {
      provider: "openai-compatible" as const,
      connectionId: "lab",
      apiKey: secret,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    };
    await expect(discoverProviderModels(setup)).resolves.toEqual([
      "model-a",
      "model-z",
    ]);

    const root = await mkdtemp(join(tmpdir(), "tmsh-api-setup-"));
    const configPath = join(root, "tmsh.local.json");
    const result = await saveApiConnection({
      configPath,
      setup,
      modelIds: ["model-a", "model-z"],
    });
    const configText = await readFile(configPath, "utf8");
    const envText = await readFile(result.envPath, "utf8");
    expect(configText).not.toContain(secret);
    expect(configText).toContain("lab.model-a");
    expect(envText).toContain(JSON.stringify(secret));
    expect(result.descriptors).toHaveLength(2);

    delete process.env.TMSH_LAB_API_KEY;
    await loadLocalEnvironment(root);
    expect(process.env.TMSH_LAB_API_KEY).toBe(secret);
  });

  it("fails closed on unquoted or duplicate local secret records", () => {
    expect(() => parseLocalEnvironment("KEY=plain\n")).toThrow(
      "must be a JSON string",
    );
    expect(() => parseLocalEnvironment('KEY="one"\nKEY="two"\n')).toThrow(
      "duplicate local environment name",
    );
  });

  it("classifies OpenCode Go models by their documented API protocol", async () => {
    expect(providerDefaultBaseUrl("opencode-go")).toBe(
      "https://opencode.ai/zen/go/v1",
    );
    expect(descriptorProvider("opencode-go", "deepseek-v4-flash")).toBe(
      "openai-compatible",
    );
    expect(descriptorProvider("opencode-go", "gpt-5.6-luna")).toBe("openai");
    expect(descriptorProvider("opencode-go", "minimax-m3")).toBe("anthropic");
    expect(descriptorProvider("opencode-go", "qwen3.8-max")).toBe("anthropic");
    expect(() => descriptorProvider("opencode-go", "future-unknown")).toThrow(
      "OpenCode Go model protocol is unknown",
    );

    const root = await mkdtemp(join(tmpdir(), "tmsh-opencode-go-"));
    const result = await saveApiConnection({
      configPath: join(root, "tmsh.local.json"),
      setup: {
        provider: "opencode-go",
        connectionId: "opencode-go",
        apiKey: "local-test-secret",
      },
      modelIds: ["deepseek-v4-flash", "gpt-5.6-luna", "minimax-m3"],
    });

    expect(result.descriptors.map((item) => item.provider)).toEqual([
      "openai-compatible",
      "openai",
      "anthropic",
    ]);
    expect(
      result.descriptors.every(
        (item) => item.baseUrl === "https://opencode.ai/zen/go/v1",
      ),
    ).toBe(true);
    expect(result.descriptors.map((item) => item.capabilities.at(-1))).toEqual([
      "opencode-go-chat-completions",
      "opencode-go-responses",
      "opencode-go-messages",
    ]);
  });

  it("runs the shared CLI/TUI wizard path with masked-input prompts abstracted", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "wizard-model" }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("test server has no TCP address");
    const root = await mkdtemp(join(tmpdir(), "tmsh-api-wizard-"));
    const result = await runApiSetupWizard(join(root, "tmsh.local.json"), {
      chooseProvider: async () => "openai-compatible",
      connectionId: async () => "wizard",
      baseUrl: async () => `http://127.0.0.1:${address.port}/v1`,
      apiKey: async () => "wizard-secret",
      models: async (models) => {
        expect(models).toEqual(["wizard-model"]);
        return [...models];
      },
    });
    expect(result.descriptors[0]?.id).toBe("wizard.wizard-model");
    expect(await readFile(result.configPath, "utf8")).not.toContain(
      "wizard-secret",
    );
  });
});
