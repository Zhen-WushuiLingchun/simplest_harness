import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DeepPartial, TmshConfig } from "../core/config.js";
import { resolveConfig } from "../core/config.js";
import type { ModelDescriptor } from "../core/types.js";
import { fetchWebContent } from "../tools/http-fetch.js";
import { saveLocalSecret } from "./local-env.js";

export type ApiProvider =
  "deepseek" | "openai" | "anthropic" | "openai-compatible";

export interface ProviderSetup {
  readonly provider: ApiProvider;
  readonly connectionId: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export interface ApiSetupResult {
  readonly configPath: string;
  readonly envPath: string;
  readonly apiKeyEnv: string;
  readonly descriptors: readonly ModelDescriptor[];
  readonly defaultModel?: string;
}

export function providerDefaultBaseUrl(provider: ApiProvider): string {
  switch (provider) {
    case "deepseek":
      return "https://api.deepseek.com";
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "openai-compatible":
      throw new Error("OpenAI-compatible provider requires a base URL");
  }
}

export async function discoverProviderModels(
  input: ProviderSetup,
): Promise<string[]> {
  validateConnectionId(input.connectionId);
  if (input.apiKey.length === 0) throw new Error("API key must not be empty");
  const baseUrl = normalizeBaseUrl(
    input.baseUrl ?? providerDefaultBaseUrl(input.provider),
  );
  const headers: Record<string, string> =
    input.provider === "anthropic"
      ? {
          "anthropic-version": "2023-06-01",
          "x-api-key": input.apiKey,
        }
      : { Authorization: `Bearer ${input.apiKey}` };
  const response = await fetchWebContent({
    url: `${baseUrl}/models`,
    headers,
    timeoutMs: 20_000,
    maxBytes: 2_000_000,
    maxRedirects: 0,
  });
  if (response.status < 200 || response.status >= 300)
    throw new Error(
      `model discovery failed with HTTP ${response.status} from ${response.finalUrl}`,
    );
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new Error("model discovery returned invalid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw new Error("model discovery returned an invalid object");
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data))
    throw new Error("model discovery response does not contain a data array");
  const ids = new Set<string>();
  for (const item of data) {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.trim().length > 0) ids.add(id.trim());
  }
  if (ids.size === 0) throw new Error("provider returned no selectable models");
  return [...ids].sort((left, right) => left.localeCompare(right));
}

export async function saveApiConnection(input: {
  readonly configPath: string;
  readonly setup: ProviderSetup;
  readonly modelIds: readonly string[];
}): Promise<ApiSetupResult> {
  validateConnectionId(input.setup.connectionId);
  const modelIds = [...new Set(input.modelIds.map((id) => id.trim()))].filter(
    Boolean,
  );
  if (modelIds.length === 0) throw new Error("select at least one model");
  const raw = await readRawConfig(input.configPath);
  const apiKeyEnv = `TMSH_${input.setup.connectionId
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "_")}_API_KEY`;
  const descriptors = modelIds.map((model) =>
    descriptorFor(input.setup, apiKeyEnv, model),
  );
  if (raw.models !== undefined && !Array.isArray(raw.models))
    throw new Error("config models must be an array");
  const previousModels = (raw.models ?? []) as ModelDescriptor[];
  const byId = new Map(previousModels.map((model) => [model.id, model]));
  for (const descriptor of descriptors) byId.set(descriptor.id, descriptor);
  const merged: DeepPartial<TmshConfig> = {
    ...raw,
    models: [...byId.values()],
    defaultModel:
      typeof raw.defaultModel === "string"
        ? raw.defaultModel
        : descriptors[0]!.id,
  };
  resolveConfig(merged);
  await writeJsonAtomic(input.configPath, merged);
  const envPath = await saveLocalSecret(
    dirname(input.configPath),
    apiKeyEnv,
    input.setup.apiKey,
  );
  return {
    configPath: input.configPath,
    envPath,
    apiKeyEnv,
    descriptors,
    ...(typeof merged.defaultModel === "string"
      ? { defaultModel: merged.defaultModel }
      : {}),
  };
}

function descriptorFor(
  setup: ProviderSetup,
  apiKeyEnv: string,
  model: string,
): ModelDescriptor {
  const provider =
    setup.provider === "deepseek" ? "openai-compatible" : setup.provider;
  const baseUrl =
    setup.provider === "openai-compatible" || setup.provider === "deepseek"
      ? normalizeBaseUrl(
          setup.baseUrl ?? providerDefaultBaseUrl(setup.provider),
        )
      : undefined;
  return {
    id: `${setup.connectionId}.${modelSlug(model)}`,
    provider,
    model,
    apiKeyEnv,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    supportsTools: true,
    supportsImages: false,
    capabilities: ["discovered", "tool-use-unverified"],
  };
}

function modelSlug(model: string): string {
  const readable = model.replace(/[^A-Za-z0-9_.:-]/gu, "-").slice(0, 80);
  if (readable === model && readable.length > 0) return readable;
  const digest = createHash("sha256").update(model).digest("hex").slice(0, 8);
  return `${readable || "model"}-${digest}`;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("provider base URL must use http or https");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function validateConnectionId(value: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(value))
    throw new Error(
      "connection ID must start with a lowercase letter and contain only a-z, 0-9, _ or -",
    );
}

async function readRawConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error(`config must contain a JSON object: ${path}`);
    return value as Record<string, unknown>;
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
