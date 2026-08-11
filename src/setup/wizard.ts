import { checkbox, input, password, select } from "@inquirer/prompts";
import { stdout } from "node:process";
import {
  discoverProviderModels,
  providerDefaultBaseUrl,
  saveApiConnection,
  type ApiProvider,
  type ApiSetupResult,
  type ProviderSetup,
} from "./api-setup.js";

export interface ApiWizardPrompts {
  readonly chooseProvider: () => Promise<ApiProvider>;
  readonly connectionId: (provider: ApiProvider) => Promise<string>;
  readonly baseUrl: () => Promise<string>;
  readonly apiKey: () => Promise<string>;
  readonly models: (models: readonly string[]) => Promise<string[]>;
}

export async function runApiSetupWizard(
  configPath: string,
  prompts: ApiWizardPrompts = interactivePrompts,
): Promise<ApiSetupResult> {
  const provider = await prompts.chooseProvider();
  const connectionId = await prompts.connectionId(provider);
  const baseUrl =
    provider === "openai-compatible"
      ? await prompts.baseUrl()
      : providerDefaultBaseUrl(provider);
  const apiKey = await prompts.apiKey();
  const setup: ProviderSetup = {
    provider,
    connectionId,
    apiKey,
    baseUrl,
  };
  stdout.write(`正在从 ${new URL(baseUrl).origin} 获取可用模型…\n`);
  const models = await discoverProviderModels(setup);
  const selected = await prompts.models(models);
  const result = await saveApiConnection({
    configPath,
    setup,
    modelIds: selected,
  });
  stdout.write(
    `已接入 ${result.descriptors.length} 个模型。描述写入 ${result.configPath}\n密钥以本地明文保存到 ${result.envPath}，不会写入事件或 Git。${process.platform === "win32" ? " Windows chmod 不能提供 POSIX 等价隔离，请保护当前用户账户。" : " 文件权限已尝试设为 0600。"}\n`,
  );
  return result;
}

const interactivePrompts: ApiWizardPrompts = {
  chooseProvider: () =>
    select<ApiProvider>({
      message: "选择 API 提供商",
      choices: [
        { name: "DeepSeek", value: "deepseek" },
        { name: "OpenAI", value: "openai" },
        { name: "Anthropic", value: "anthropic" },
        { name: "其他 OpenAI-compatible API", value: "openai-compatible" },
      ],
    }),
  connectionId: (provider) =>
    input({
      message: "连接名称（用于模型 ID 和本地环境变量）",
      default: provider === "openai-compatible" ? "custom" : provider,
      validate: (value) =>
        /^[a-z][a-z0-9_-]{0,31}$/u.test(value)
          ? true
          : "请使用小写字母开头，只包含 a-z、0-9、_ 或 -，最长 32 字符",
    }),
  baseUrl: () =>
    input({
      message: "API Base URL（应包含 /v1 时请保留）",
      validate: validHttpUrl,
    }),
  apiKey: () =>
    password({
      message: "API Key（输入已隐藏）",
      mask: "*",
      validate: (value) => (value.length > 0 ? true : "API Key 不能为空"),
    }),
  models: (models) =>
    checkbox<string>({
      message: `选择要接入的模型（发现 ${models.length} 个）`,
      choices: models.map((model) => ({ name: model, value: model })),
      pageSize: 20,
      loop: false,
      required: true,
    }),
};

function validHttpUrl(value: string): true | string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? true
      : "URL 必须使用 http 或 https";
  } catch {
    return "请输入有效 URL";
  }
}
