#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { TmshApiServer } from "./api/server.js";
import { resolveConfig, type TmshConfig } from "./core/config.js";
import { loadConfig } from "./core/config-file.js";
import type { RunEvent } from "./core/types.js";
import { createRuntime } from "./runtime/runtime.js";
import { runTmshTui } from "./tui/app.js";
import { serveTmshMcpStdio } from "./mcp/server.js";
import { loadLocalEnvironment } from "./setup/local-env.js";
import { runApiSetupWizard } from "./setup/wizard.js";
import { relaunchTuiWithBun } from "./tui/bun-runtime.js";

const distributionRoot = fileURLToPath(new URL("../", import.meta.url));

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "help";
  const args = argv.slice(1);
  if (command === "help" || command === "--help" || command === "-h") {
    stdout.write(helpText());
    return 0;
  }
  if (command === "tui") {
    const relaunched = relaunchTuiWithBun(argv);
    if (relaunched !== undefined) return relaunched;
  }
  const flags = parseFlags(args);
  const loaded = await loadConfig(process.cwd(), stringFlag(flags, "config"));
  const configPath = loaded.source ?? resolve(process.cwd(), "tmsh.local.json");
  const localEnvironment = await loadLocalEnvironment(dirname(configPath));
  const config = flags.has("yolo")
    ? resolveConfig({ ...loaded.config, autonomy: { mode: "yolo" } })
    : loaded.config;

  if (command === "api") {
    await runApiSetupWizard(configPath);
    return 0;
  }

  if (command === "doctor") {
    const runtime = await createRuntime(config, distributionRoot);
    try {
      stdout.write(
        `${JSON.stringify({ ok: true, node: process.version, config: loaded.source ?? null, localEnv: { path: localEnvironment.path, loadedNames: localEnvironment.loaded }, dataDir: config.dataDir, autonomy: config.autonomy.mode, models: runtime.models.list(), mcp: runtime.mcp.list() }, null, 2)}\n`,
      );
      return runtime.models.list().some((model) => model.available) ||
        config.models.length === 0
        ? 0
        : 1;
    } finally {
      await runtime.close();
    }
  }
  if (command === "serve") {
    const runtime = await createRuntime(config, distributionRoot);
    const server = new TmshApiServer(
      config,
      runtime.engine,
      runtime.events,
      runtime.models,
    );
    const address = await server.start();
    if (config.autonomy.mode === "yolo")
      stdout.write(
        "WARNING: YOLO mode is active; mutating tool calls do not require per-call approval.\n",
      );
    stdout.write(`TMSH API listening at ${address.url}\n`);
    await waitForSignal();
    await server.close();
    await runtime.close();
    return 0;
  }
  if (command === "mcp") {
    const runtime = await createRuntime(config, distributionRoot);
    try {
      await serveTmshMcpStdio(runtime.engine, runtime.models);
    } finally {
      await runtime.close();
    }
    return 0;
  }
  if (command === "models") {
    const runtime = await createRuntime(config, distributionRoot);
    stdout.write(`${JSON.stringify(runtime.models.list(), null, 2)}\n`);
    await runtime.close();
    return 0;
  }
  if (command === "tools") {
    const runtime = await createRuntime(config, distributionRoot);
    stdout.write(`${JSON.stringify(runtime.engine.tools.list(), null, 2)}\n`);
    await runtime.close();
    return 0;
  }
  if (command === "run") {
    const goal = positional(args).join(" ").trim();
    if (goal.length === 0) throw new Error("tmsh run requires a goal");
    const runtime = await createRuntime(config, distributionRoot);
    if (config.autonomy.mode === "yolo")
      stdout.write("WARNING: YOLO mode is active.\n");
    const modelId = stringFlag(flags, "model");
    const runId = await runtime.engine.start({
      goal,
      workspace: resolve(stringFlag(flags, "workspace") ?? process.cwd()),
      ...(modelId === undefined ? {} : { modelId }),
      autonomy: config.autonomy.mode,
    });
    const seen = new Set<string>();
    const handle = (event: RunEvent): void => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      void displayEvent(event, runtime.engine);
    };
    const unsubscribe = runtime.events.subscribe(runId, handle);
    for (const event of await runtime.events.replay(runId)) handle(event);
    const result = await runtime.engine.wait(runId);
    unsubscribe();
    await runtime.close();
    if (result.error !== undefined)
      stdout.write(`\n${result.status}: ${result.error}\n`);
    return result.status === "done" ? 0 : 1;
  }
  if (command === "tui") {
    const runtime = await createRuntime(config, distributionRoot);
    const workspace = resolve(stringFlag(flags, "workspace") ?? process.cwd());
    const modelId = stringFlag(flags, "model");
    const goal = positional(args).join(" ").trim();
    try {
      await runTmshTui(
        runtime,
        workspace,
        modelId,
        goal.length === 0 ? undefined : goal,
        () => runApiSetupWizard(configPath),
      );
    } finally {
      await runtime.close();
    }
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

async function displayEvent(
  event: RunEvent,
  engine: import("./runtime/run-engine.js").RunEngine,
): Promise<void> {
  if (event.type === "model.response") {
    const data = event.data as Record<string, unknown>;
    if (typeof data.text === "string" && data.text.length > 0)
      stdout.write(data.text);
  } else if (event.type === "process.output") {
    const data = event.data as Record<string, unknown>;
    if (typeof data.text === "string") stdout.write(data.text);
  } else if (event.type === "input.required") {
    const data = event.data as Record<string, unknown>;
    const callId = String(data.toolCallId);
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await prompt.question(
        `\nAllow ${String(data.name)} (${String(data.effect)})? [y/N] `,
      );
      engine.approve(event.runId, callId, /^y(es)?$/iu.test(answer.trim()));
    } finally {
      prompt.close();
    }
  }
}

function parseFlags(args: readonly string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) flags.set(name!, inline);
    else if (name === "yolo") flags.set(name, true);
    else if (
      args[index + 1] !== undefined &&
      !args[index + 1]!.startsWith("--")
    ) {
      flags.set(name!, args[index + 1]!);
      index += 1;
    } else flags.set(name!, true);
  }
  return flags;
}

function positional(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]!.startsWith("--")) {
      const name = args[index]!.slice(2).split("=", 1)[0];
      if (
        name !== "yolo" &&
        !args[index]!.includes("=") &&
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith("--")
      )
        index += 1;
    } else result.push(args[index]!);
  }
  return result;
}

function stringFlag(
  flags: ReadonlyMap<string, string | true>,
  name: string,
): string | undefined {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  return value;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    const done = (): void => resolveSignal();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function helpText(): string {
  return `TMSH - the most simplest model-directed harness\n\nUsage:\n  tmsh api [--config PATH]\n  tmsh run "goal" [--model ID] [--workspace PATH] [--yolo] [--config PATH]\n  tmsh tui ["initial goal"] [--model ID] [--workspace PATH] [--yolo] [--config PATH]\n  tmsh serve [--yolo] [--config PATH]\n  tmsh mcp [--config PATH]\n  tmsh models [--config PATH]\n  tmsh tools [--config PATH]\n  tmsh doctor [--config PATH]\n\nInside the TUI, /api configures providers and /resume restores ignored local sessions.\n--yolo explicitly bypasses per-call approval for mutating/external tools; audit and compaction validation remain active.\n`;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `tmsh: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
