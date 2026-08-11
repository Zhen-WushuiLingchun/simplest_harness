import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
} from "@opentui/core";
import { createInterface as createLineInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import type { TmshConfig } from "../core/config.js";
import type { EventStore } from "../core/event-store.js";
import { sessionTranscript, type SessionStore } from "../core/session-store.js";
import type { JsonValue, RunEvent } from "../core/types.js";
import type { ModelRegistry } from "../models/registry.js";
import type { RunEngine } from "../runtime/run-engine.js";
import type { ApiSetupResult } from "../setup/api-setup.js";

export interface TuiServices {
  readonly config: TmshConfig;
  readonly events: EventStore;
  readonly sessions: SessionStore;
  readonly models: ModelRegistry;
  readonly engine: RunEngine;
}

export interface TmshTuiView {
  readonly submit: (value: string) => Promise<void>;
  readonly currentRunId: () => string | undefined;
  readonly transcriptText: () => string;
  readonly selectedModelId: () => string | undefined;
  readonly selectedSessionId: () => string | undefined;
  destroy(): void;
}

interface TuiHooks {
  readonly requestApiSetup?: () => void;
}

interface TuiExitState {
  readonly action: "quit" | "api";
  readonly modelId?: string;
  readonly sessionId?: string;
}

export function createTmshTui(
  renderer: CliRenderer,
  services: TuiServices,
  workspace: string,
  initialModel?: string,
  initialSessionId?: string,
  hooks: TuiHooks = {},
): TmshTuiView {
  let selectedModel =
    initialModel ??
    services.config.defaultModel ??
    services.models.list().find((item) => item.available)?.descriptor.id;
  let currentRunId: string | undefined;
  let selectedSessionId = initialSessionId;
  let pendingApproval: { runId: string; callId: string } | undefined;
  let transcript = "TMSH ready. Type a goal, /help, or /quit.\n";
  let unsubscribe: (() => void) | undefined;
  const seen = new Set<string>();

  const app = new BoxRenderable(renderer, {
    id: "tmsh-app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#111318",
  });
  const headerBox = new BoxRenderable(renderer, {
    id: "tmsh-header-box",
    height: 1,
    backgroundColor:
      services.config.autonomy.mode === "yolo" ? "#7f1d1d" : "#1f2937",
  });
  const header = new TextRenderable(renderer, {
    id: "tmsh-header",
    height: 1,
    width: "100%",
    content: "",
    fg: "#f9fafb",
  });
  headerBox.add(header);
  const scroll = new ScrollBoxRenderable(renderer, {
    id: "tmsh-transcript-scroll",
    flexGrow: 1,
    border: true,
    borderColor: "#374151",
    title: " transcript ",
    stickyScroll: true,
    stickyStart: "bottom",
    scrollY: true,
    viewportCulling: true,
  });
  const transcriptView = new TextRenderable(renderer, {
    id: "tmsh-transcript",
    width: "100%",
    content: transcript,
    fg: "#d1d5db",
    paddingX: 1,
  });
  scroll.add(transcriptView);
  const status = new TextRenderable(renderer, {
    id: "tmsh-status",
    height: 2,
    content: "",
    fg: "#93c5fd",
  });
  const composerBox = new BoxRenderable(renderer, {
    id: "tmsh-composer-box",
    height: 3,
    border: true,
    borderColor: "#4b5563",
    focusedBorderColor: "#60a5fa",
    title: " goal / command ",
    paddingX: 1,
  });
  const composer = new InputRenderable(renderer, {
    id: "tmsh-composer",
    width: "100%",
    placeholder: "Describe the goal…",
    textColor: "#f9fafb",
    backgroundColor: "#111318",
    focusedBackgroundColor: "#111318",
    focusedTextColor: "#ffffff",
    onSubmit: () => {
      const value = composer.value;
      composer.value = "";
      void submit(value);
    },
    onKeyDown: (key) => {
      if (key.ctrl && key.name === "c") renderer.destroy();
    },
  });
  composerBox.add(composer);
  app.add(headerBox);
  app.add(scroll);
  app.add(status);
  app.add(composerBox);
  renderer.root.add(app);
  composer.focus();
  refreshStatus();

  async function submit(raw: string): Promise<void> {
    const value = raw.trim();
    if (value.length === 0) return;
    if (pendingApproval !== undefined) {
      const allowed = /^y(es)?$/iu.test(value);
      services.engine.approve(
        pendingApproval.runId,
        pendingApproval.callId,
        allowed,
      );
      append(
        `[approval] ${allowed ? "allowed" : "denied"} ${pendingApproval.callId}\n`,
      );
      pendingApproval = undefined;
      composer.placeholder = "Describe the next goal or command…";
      return;
    }
    if (value.startsWith("/")) {
      await command(value);
      return;
    }
    if (currentRunId !== undefined) {
      const state = services.engine.snapshot(currentRunId);
      if (!terminal(state.status)) {
        append(
          "[status] A run is active. Use /cancel, /compact, or wait for completion.\n",
        );
        return;
      }
    }
    if (selectedModel === undefined) {
      append(
        "[error] No available model. Configure one and restart the TUI.\n",
      );
      return;
    }
    if (selectedSessionId === undefined) {
      const session = await services.sessions.create({
        title: value,
        workspace,
        modelId: selectedModel,
      });
      selectedSessionId = session.id;
    }
    append(`\n[user] ${value}\n`);
    const runId = await services.engine.start({
      goal: value,
      modelId: selectedModel,
      workspace,
      autonomy: services.config.autonomy.mode,
      sessionId: selectedSessionId,
    });
    currentRunId = runId;
    unsubscribe?.();
    unsubscribe = services.events.subscribe(runId, onEvent);
    for (const event of await services.events.replay(runId)) onEvent(event);
    refreshStatus();
  }

  async function command(value: string): Promise<void> {
    const [name, ...rest] = value.split(/\s+/u);
    if (name === "/quit") {
      renderer.destroy();
    } else if (name === "/help") {
      append(
        "Commands: /api, /model ID, /models, /resume [ID], /new, /compact, /cancel, /runs, /quit.\n",
      );
    } else if (name === "/api") {
      if (hasActiveRun())
        append("[status] Finish or cancel the active run before /api.\n");
      else if (hooks.requestApiSetup === undefined)
        append("[error] API setup is unavailable in this TUI host.\n");
      else {
        append("[api] Leaving the renderer for masked API setup…\n");
        hooks.requestApiSetup();
        renderer.destroy();
      }
    } else if (name === "/models") {
      append(
        `${services.models
          .list()
          .map(
            (item) =>
              `${item.descriptor.id}:${item.available ? "ready" : item.reason}`,
          )
          .join("\n")}\n`,
      );
    } else if (name === "/model") {
      const id = rest[0];
      if (
        id === undefined ||
        !services.models
          .list()
          .some((item) => item.descriptor.id === id && item.available)
      ) {
        append(`[error] Model is unavailable: ${id ?? "<missing>"}\n`);
      } else {
        selectedModel = id;
        append(`[model] selected ${id}\n`);
      }
    } else if (name === "/resume") {
      if (hasActiveRun()) {
        append("[status] Finish or cancel the active run before /resume.\n");
      } else if (rest[0] === undefined) {
        const sessions = await services.sessions.list(workspace);
        append(
          sessions.length === 0
            ? "[session] No saved sessions for this workspace.\n"
            : `${sessions
                .map(
                  (item) =>
                    `${item.id.slice(0, 8)} ${item.updatedAt} ${item.modelId} ${item.title}`,
                )
                .join("\n")}\nUse /resume <id-or-prefix>.\n`,
        );
      } else {
        const session = await services.sessions.resolve(rest[0], workspace);
        selectedSessionId = session.id;
        selectedModel = session.modelId;
        currentRunId = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
        replaceTranscript(
          `[session ${session.id.slice(0, 8)}] ${session.title}\n${sessionTranscript(session)}\n[session] resumed; enter the next goal.\n`,
        );
      }
    } else if (name === "/new") {
      if (hasActiveRun())
        append("[status] Finish or cancel the active run before /new.\n");
      else {
        selectedSessionId = undefined;
        currentRunId = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
        replaceTranscript(
          "[session] New conversation selected; the next goal creates it.\n",
        );
      }
    } else if (name === "/compact") {
      if (currentRunId === undefined) append("[status] No active run.\n");
      else {
        services.engine.requestCompaction(currentRunId);
        append(
          "[context] manual compaction requested; it will run at the next model boundary.\n",
        );
      }
    } else if (name === "/cancel") {
      if (currentRunId === undefined) append("[status] No active run.\n");
      else services.engine.cancel(currentRunId);
    } else if (name === "/runs") {
      append(
        `${services.engine
          .list()
          .map((run) => `${run.runId.slice(0, 8)} ${run.status} ${run.modelId}`)
          .join("\n")}\n`,
      );
    } else append(`[error] Unknown command: ${name}\n`);
    refreshStatus();
  }

  function onEvent(event: RunEvent): void {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    const data = objectData(event.data);
    switch (event.type) {
      case "model.response":
        if (typeof data.text === "string" && data.text.length > 0)
          append(`\n[assistant] ${data.text}\n`);
        break;
      case "tool.call":
        append(`[tool →] ${String(data.name)}\n`);
        break;
      case "tool.result":
        append(
          `[tool ←] ${String(data.name)} ${data.ok === true ? "ok" : "failed"}\n`,
        );
        break;
      case "process.output":
        if (typeof data.text === "string") append(data.text);
        break;
      case "context.compaction.completed":
        append(
          `[context] compacted ${String(data.artifactDigest).slice(0, 12)}\n`,
        );
        break;
      case "context.compaction.failed":
        append(
          `[context] compaction rejected: ${JSON.stringify(data.reasons)}\n`,
        );
        break;
      case "input.required":
        pendingApproval = {
          runId: event.runId,
          callId: String(data.toolCallId),
        };
        composer.placeholder = `Approve ${String(data.name)}? type y or n`;
        append(
          `[approval required] ${String(data.name)} (${String(data.effect)})\n`,
        );
        break;
      case "error":
        append(`[error] ${String(data.message)}\n`);
        break;
      case "done":
        append("[done]\n");
        break;
    }
    refreshStatus();
  }

  function append(text: string): void {
    transcript += text;
    if (transcript.length > 100_000)
      transcript = `[older TUI display omitted; durable event log preserved]\n${transcript.slice(-90_000)}`;
    transcriptView.content = transcript;
    scroll.scrollTo({ x: 0, y: Math.max(0, scroll.scrollHeight) });
    renderer.requestRender();
  }

  function replaceTranscript(text: string): void {
    transcript = text;
    transcriptView.content = transcript;
    renderer.requestRender();
  }

  function hasActiveRun(): boolean {
    return (
      currentRunId !== undefined &&
      !terminal(services.engine.snapshot(currentRunId).status)
    );
  }

  function refreshStatus(): void {
    const run =
      currentRunId === undefined
        ? undefined
        : services.engine.snapshot(currentRunId);
    const mode = services.config.autonomy.mode === "yolo" ? "YOLO" : "CONFIRM";
    header.content = ` TMSH  ${mode}  model=${selectedModel ?? "none"}  session=${selectedSessionId?.slice(0, 8) ?? "new"}  workspace=${workspace}`;
    status.content =
      run === undefined
        ? ` idle | models=${services.models.list().filter((item) => item.available).length}/${services.models.list().length}\n /api /resume /new; durable evidence lives in ${services.config.dataDir}`
        : ` ${run.status} | run=${run.runId.slice(0, 8)} | calls=${run.modelCalls} | input=${run.lastInputTokens} tokens | pending=${run.pendingApprovals.length}\n /compact /cancel /runs; exact ledger and event log remain outside the display buffer`;
    renderer.requestRender();
  }

  return {
    submit,
    currentRunId: () => currentRunId,
    transcriptText: () => transcript,
    selectedModelId: () => selectedModel,
    selectedSessionId: () => selectedSessionId,
    destroy: () => {
      unsubscribe?.();
      renderer.destroy();
    },
  };
}

export async function runTmshTui(
  services: TuiServices,
  workspace: string,
  initialModel?: string,
  initialGoal?: string,
  apiSetup?: () => Promise<ApiSetupResult>,
): Promise<void> {
  let modelId = initialModel;
  let sessionId: string | undefined;
  let goal = initialGoal;
  let ansiOnly = false;
  for (;;) {
    let state: TuiExitState;
    if (ansiOnly) {
      state = await runAnsiTui(
        services,
        workspace,
        modelId,
        sessionId,
        goal,
        apiSetup !== undefined,
      );
    } else {
      let renderer: CliRenderer;
      try {
        renderer = await createCliRenderer({
          exitOnCtrlC: false,
          clearOnShutdown: true,
          useMouse: true,
          screenMode: "alternate-screen",
          backgroundColor: "#111318",
        });
      } catch (error) {
        process.stderr.write(
          `[TMSH] OpenTUI unavailable; using ANSI fallback: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        ansiOnly = true;
        continue;
      }
      let action: "quit" | "api" = "quit";
      const view = createTmshTui(
        renderer,
        services,
        workspace,
        modelId,
        sessionId,
        {
          ...(apiSetup === undefined
            ? {}
            : { requestApiSetup: () => (action = "api") }),
        },
      );
      if (goal !== undefined && goal.trim().length > 0) await view.submit(goal);
      await new Promise<void>((resolve) =>
        renderer.once(CliRenderEvents.DESTROY, () => resolve()),
      );
      const selectedModel = view.selectedModelId();
      const selectedSession = view.selectedSessionId();
      state = {
        action,
        ...(selectedModel === undefined ? {} : { modelId: selectedModel }),
        ...(selectedSession === undefined
          ? {}
          : { sessionId: selectedSession }),
      };
    }
    modelId = state.modelId;
    sessionId = state.sessionId;
    goal = undefined;
    if (state.action === "quit") return;
    if (apiSetup === undefined) continue;
    try {
      const result = await apiSetup();
      for (const descriptor of result.descriptors)
        services.models.upsert(descriptor);
      modelId = result.descriptors[0]?.id ?? modelId;
    } catch (error) {
      process.stderr.write(
        `[TMSH] API setup did not complete: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

export async function runAnsiTui(
  services: TuiServices,
  workspace: string,
  initialModel?: string,
  initialSessionId?: string,
  initialGoal?: string,
  apiSetupAvailable = false,
): Promise<TuiExitState> {
  let modelId =
    initialModel ??
    services.config.defaultModel ??
    services.models.list().find((item) => item.available)?.descriptor.id;
  let runId: string | undefined;
  let sessionId = initialSessionId;
  let action: "quit" | "api" = "quit";
  let pending: { runId: string; callId: string } | undefined;
  let status = "idle";
  let transcript = "TMSH ready. Type a goal, /help, or /quit.";
  let unsubscribe: (() => void) | undefined;
  const seen = new Set<string>();
  const lines = Math.max(8, (stdout.rows ?? 24) - 5);
  const rl = createLineInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean(stdout.isTTY),
    prompt: "> ",
  });
  let closed = false;
  rl.once("close", () => {
    closed = true;
  });

  const render = (): void => {
    if (closed) return;
    stdout.write(
      formatAnsiFrame({
        mode: services.config.autonomy.mode,
        ...(modelId === undefined ? {} : { modelId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        workspace,
        status,
        transcript,
        maxTranscriptLines: lines,
        color: Boolean(stdout.isTTY),
      }),
    );
    rl.prompt(true);
  };
  const append = (text: string): void => {
    transcript += `\n${text}`;
    if (transcript.length > 100_000)
      transcript = `[older display omitted; event log preserved]\n${transcript.slice(-90_000)}`;
    render();
  };
  const onEvent = (event: RunEvent): void => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    const data = objectData(event.data);
    if (
      event.type === "model.response" &&
      typeof data.text === "string" &&
      data.text.length > 0
    )
      append(`[assistant] ${data.text}`);
    else if (event.type === "tool.call")
      append(`[tool →] ${String(data.name)}`);
    else if (event.type === "tool.result")
      append(
        `[tool ←] ${String(data.name)} ${data.ok === true ? "ok" : "failed"}`,
      );
    else if (event.type === "process.output" && typeof data.text === "string")
      append(data.text);
    else if (event.type === "context.compaction.completed")
      append(`[context] compacted ${String(data.artifactDigest).slice(0, 12)}`);
    else if (event.type === "context.compaction.failed")
      append(`[context] compaction rejected ${JSON.stringify(data.reasons)}`);
    else if (event.type === "input.required") {
      pending = { runId: event.runId, callId: String(data.toolCallId) };
      append(
        `[approval required] ${String(data.name)} (${String(data.effect)}); type y or n`,
      );
    } else if (event.type === "error")
      append(`[error] ${String(data.message)}`);
    else if (event.type === "done") append("[done]");
    if (event.type === "run.status" && typeof data.status === "string")
      status = data.status;
    if (runId !== undefined) status = services.engine.snapshot(runId).status;
    render();
  };

  const startGoal = async (goal: string): Promise<void> => {
    if (modelId === undefined) {
      append("[error] No available model is configured.");
      return;
    }
    if (
      runId !== undefined &&
      !terminal(services.engine.snapshot(runId).status)
    ) {
      append("[status] A run is active. Use /cancel or /compact.");
      return;
    }
    if (sessionId === undefined) {
      const session = await services.sessions.create({
        title: goal,
        workspace,
        modelId,
      });
      sessionId = session.id;
    }
    append(`[user] ${goal}`);
    runId = await services.engine.start({
      goal,
      modelId,
      workspace,
      autonomy: services.config.autonomy.mode,
      sessionId,
    });
    status = services.engine.snapshot(runId).status;
    unsubscribe?.();
    unsubscribe = services.events.subscribe(runId, onEvent);
    for (const event of await services.events.replay(runId)) onEvent(event);
  };

  let inputQueue = Promise.resolve();
  rl.on("line", (raw) => {
    inputQueue = inputQueue
      .then(async () => {
        const value = raw.trim();
        if (pending !== undefined) {
          services.engine.approve(
            pending.runId,
            pending.callId,
            /^y(es)?$/iu.test(value),
          );
          pending = undefined;
        } else if (value === "/quit") {
          rl.close();
          return;
        } else if (value === "/api") {
          if (isActive())
            append("[status] Finish or cancel the active run first.");
          else if (!apiSetupAvailable)
            append("[error] API setup is unavailable in this TUI host.");
          else {
            action = "api";
            rl.close();
            return;
          }
        } else if (value === "/help")
          append(
            "Commands: /api, /model ID, /models, /resume [ID], /new, /compact, /cancel, /runs, /quit.",
          );
        else if (value === "/models")
          append(
            services.models
              .list()
              .map(
                (item) =>
                  `${item.descriptor.id}:${item.available ? "ready" : item.reason}`,
              )
              .join("\n"),
          );
        else if (value.startsWith("/model ")) {
          const requested = value.slice(7).trim();
          if (
            services.models
              .list()
              .some(
                (item) => item.descriptor.id === requested && item.available,
              )
          )
            modelId = requested;
          else append(`[error] Model is unavailable: ${requested}`);
        } else if (value === "/resume") {
          const sessions = await services.sessions.list(workspace);
          append(
            sessions.length === 0
              ? "[session] No saved sessions for this workspace."
              : `${sessions
                  .map(
                    (item) =>
                      `${item.id.slice(0, 8)} ${item.updatedAt} ${item.modelId} ${item.title}`,
                  )
                  .join("\n")}\nUse /resume <id-or-prefix>.`,
          );
        } else if (value.startsWith("/resume ")) {
          if (isActive())
            append("[status] Finish or cancel the active run first.");
          else {
            const session = await services.sessions.resolve(
              value.slice(8).trim(),
              workspace,
            );
            sessionId = session.id;
            modelId = session.modelId;
            runId = undefined;
            unsubscribe?.();
            unsubscribe = undefined;
            transcript = `[session ${session.id.slice(0, 8)}] ${session.title}\n${sessionTranscript(session)}\n[session] resumed; enter the next goal.`;
          }
        } else if (value === "/new") {
          if (isActive())
            append("[status] Finish or cancel the active run first.");
          else {
            sessionId = undefined;
            runId = undefined;
            unsubscribe?.();
            unsubscribe = undefined;
            transcript =
              "[session] New conversation selected; the next goal creates it.";
          }
        } else if (value === "/compact" && runId !== undefined)
          services.engine.requestCompaction(runId);
        else if (value === "/cancel" && runId !== undefined)
          services.engine.cancel(runId);
        else if (value === "/runs")
          append(
            services.engine
              .list()
              .map(
                (run) =>
                  `${run.runId.slice(0, 8)} ${run.status} ${run.modelId}`,
              )
              .join("\n"),
          );
        else if (value.startsWith("/"))
          append(`[error] Unknown command: ${value}`);
        else if (value.length > 0) await startGoal(value);
        render();
      })
      .catch((error) => {
        if (!closed)
          append(
            `[error] ${error instanceof Error ? error.message : String(error)}`,
          );
      });
  });
  rl.once("SIGINT", () => rl.close());
  render();
  if (initialGoal !== undefined && initialGoal.trim().length > 0)
    await startGoal(initialGoal.trim());
  await new Promise<void>((resolve) => rl.once("close", resolve));
  await inputQueue;
  unsubscribe?.();
  if (stdout.isTTY) stdout.write("\x1b[2J\x1b[H");
  return {
    action,
    ...(modelId === undefined ? {} : { modelId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };

  function isActive(): boolean {
    return (
      runId !== undefined && !terminal(services.engine.snapshot(runId).status)
    );
  }
}

export function formatAnsiFrame(input: {
  readonly mode: "confirm" | "yolo";
  readonly modelId?: string;
  readonly sessionId?: string;
  readonly workspace: string;
  readonly status: string;
  readonly transcript: string;
  readonly maxTranscriptLines: number;
  readonly color: boolean;
}): string {
  const transcriptLines = input.transcript
    .split("\n")
    .slice(-input.maxTranscriptLines);
  const marker = input.mode === "yolo" ? "YOLO" : "CONFIRM";
  const header = `TMSH ${marker} | model=${input.modelId ?? "none"} | session=${input.sessionId?.slice(0, 8) ?? "new"} | ${input.status}`;
  const body = `${header}\n${"─".repeat(Math.min(100, Math.max(20, header.length)))}\n${transcriptLines.join("\n")}\n${"─".repeat(40)}\nworkspace=${input.workspace}\n`;
  if (!input.color) return body;
  const markerColor = input.mode === "yolo" ? "\x1b[41;97m" : "\x1b[44;97m";
  return `\x1b[2J\x1b[H${markerColor}${header}\x1b[0m${body.slice(header.length)}`;
}

function objectData(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function terminal(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}
