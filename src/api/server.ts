import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { TmshConfig } from "../core/config.js";
import type { EventStore } from "../core/event-store.js";
import type { RunEvent } from "../core/types.js";
import type { ModelRegistry } from "../models/registry.js";
import type { RunEngine, StartRunInput } from "../runtime/run-engine.js";

export class TmshApiServer {
  readonly #config: TmshConfig;
  readonly #engine: RunEngine;
  readonly #events: EventStore;
  readonly #models: ModelRegistry;
  #server: Server | undefined;

  public constructor(
    config: TmshConfig,
    engine: RunEngine,
    events: EventStore,
    models: ModelRegistry,
  ) {
    this.#config = config;
    this.#engine = engine;
    this.#events = events;
    this.#models = models;
  }

  public async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.#server !== undefined)
      throw new Error("API server is already started");
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        if (!response.headersSent)
          sendJson(response, error instanceof HttpError ? error.status : 500, {
            error: messageOf(error),
          });
        else response.end();
      });
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#config.port, this.#config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const hostForUrl = address.address.includes(":")
      ? `[${address.address}]`
      : address.address;
    return {
      host: address.address,
      port: address.port,
      url: `http://${hostForUrl}:${address.port}`,
    };
  }

  public async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
    server.closeAllConnections();
    await closed;
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, version: "0.1.0" });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/models") {
      sendJson(response, 200, { models: this.#models.list() });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/tools") {
      sendJson(response, 200, { tools: this.#engine.tools.list() });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/runs") {
      sendJson(response, 200, { runs: this.#engine.list() });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/runs") {
      const input = parseStartRun(await readJson(request));
      const runId = await this.#engine.start(input);
      sendJson(response, 202, { runId, run: this.#engine.snapshot(runId) });
      return;
    }
    if (parts[0] === "v1" && parts[1] === "runs" && parts[2] !== undefined) {
      const runId = decodeURIComponent(parts[2]);
      if (method === "GET" && parts.length === 3) {
        sendJson(response, 200, { run: this.#engine.snapshot(runId) });
        return;
      }
      if (method === "GET" && parts[3] === "events" && parts.length === 4) {
        sendJson(response, 200, { events: await this.#events.replay(runId) });
        return;
      }
      if (method === "GET" && parts[3] === "events" && parts[4] === "stream") {
        await this.#streamEvents(
          request,
          response,
          runId,
          Number(url.searchParams.get("after") ?? 0),
        );
        return;
      }
      if (method === "POST" && parts[3] === "cancel") {
        this.#engine.cancel(runId);
        sendJson(response, 202, { cancelled: true });
        return;
      }
      if (
        method === "POST" &&
        parts[3] === "approvals" &&
        parts[4] !== undefined
      ) {
        const body = (await readJson(request)) as { allowed?: unknown };
        if (typeof body.allowed !== "boolean")
          throw new HttpError(400, "allowed must be boolean");
        this.#engine.approve(runId, decodeURIComponent(parts[4]), body.allowed);
        sendJson(response, 200, { resolved: true, allowed: body.allowed });
        return;
      }
    }
    sendJson(response, 404, { error: "not found" });
  }

  async #streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
    runId: string,
    after: number,
  ): Promise<void> {
    if (!Number.isInteger(after) || after < 0)
      throw new HttpError(400, "after must be a non-negative integer");
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const buffered: RunEvent[] = [];
    let live = false;
    const unsubscribe = this.#events.subscribe(runId, (event) => {
      if (live) writeEvent(response, event);
      else buffered.push(event);
    });
    let last = after;
    for (const event of await this.#events.replay(runId)) {
      if (event.seq > after) writeEvent(response, event);
      last = Math.max(last, event.seq);
    }
    for (const event of buffered) {
      if (event.seq > last) writeEvent(response, event);
      last = Math.max(last, event.seq);
    }
    live = true;
    request.once("close", unsubscribe);
    response.write(": connected\n\n");
  }
}

function writeEvent(response: ServerResponse, event: RunEvent): void {
  response.write(
    `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 1_000_000,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new HttpError(413, "request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
  });
  response.end(bytes);
}

function parseStartRun(input: unknown): StartRunInput {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new HttpError(400, "run body must be an object");
  const value = input as Record<string, unknown>;
  if (typeof value.goal !== "string" || value.goal.trim().length === 0)
    throw new HttpError(400, "goal must be a non-empty string");
  if (typeof value.workspace !== "string" || value.workspace.length === 0)
    throw new HttpError(400, "workspace must be a non-empty string");
  if (value.modelId !== undefined && typeof value.modelId !== "string")
    throw new HttpError(400, "modelId must be a string");
  if (
    value.autonomy !== undefined &&
    value.autonomy !== "confirm" &&
    value.autonomy !== "yolo"
  )
    throw new HttpError(400, "autonomy must be confirm or yolo");
  if (
    value.maxCalls !== undefined &&
    (!Number.isInteger(value.maxCalls) || (value.maxCalls as number) <= 0)
  )
    throw new HttpError(400, "maxCalls must be a positive integer");
  return {
    goal: value.goal,
    workspace: value.workspace,
    ...(value.modelId === undefined
      ? {}
      : { modelId: value.modelId as string }),
    ...(value.autonomy === undefined
      ? {}
      : { autonomy: value.autonomy as "confirm" | "yolo" }),
    ...(value.maxCalls === undefined
      ? {}
      : { maxCalls: value.maxCalls as number }),
  };
}

class HttpError extends Error {
  public readonly status: number;
  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
