import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type ProcessStatus =
  "running" | "exited" | "killed" | "timed_out" | "spawn_error";
export type OutputChannel = "stdout" | "stderr";

export interface ProcessOutput {
  readonly cursor: number;
  readonly channel: OutputChannel;
  readonly text: string;
}

export interface ProcessSnapshot {
  readonly processId: string;
  readonly pid?: number;
  readonly status: ProcessStatus;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly nextCursor: number;
  readonly truncated: boolean;
  readonly droppedBytes: number;
  readonly output: readonly ProcessOutput[];
  readonly error?: string;
}

export interface StartProcessInput {
  readonly file: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly shell?: boolean;
  readonly background?: boolean;
  readonly timeoutMs: number;
  readonly yieldMs: number;
  readonly maxOutputBytes: number;
}

export interface WaitProcessInput {
  readonly processId: string;
  readonly cursor?: number;
  readonly yieldMs: number;
}

interface ProcessRecord {
  readonly id: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly startedAt: string;
  readonly events: EventEmitter;
  readonly output: ProcessOutput[];
  readonly maxOutputBytes: number;
  status: ProcessStatus;
  outputBytes: number;
  droppedBytes: number;
  nextCursor: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  endedAt?: string;
  error?: string;
  timeout?: NodeJS.Timeout;
}

export class ProcessManager {
  readonly #records = new Map<string, ProcessRecord>();
  readonly #onOutput:
    ((processId: string, output: ProcessOutput) => void) | undefined;

  public constructor(
    onOutput?: (processId: string, output: ProcessOutput) => void,
  ) {
    this.#onOutput = onOutput;
  }

  public async start(input: StartProcessInput): Promise<ProcessSnapshot> {
    validateStart(input);
    const child = spawn(input.file, [...(input.args ?? [])], {
      cwd: input.cwd,
      env:
        input.env === undefined
          ? process.env
          : { ...process.env, ...input.env },
      shell: input.shell ?? false,
      windowsHide: true,
      stdio: "pipe",
    });
    const id = randomUUID();
    const record: ProcessRecord = {
      id,
      child,
      startedAt: new Date().toISOString(),
      events: new EventEmitter(),
      output: [],
      maxOutputBytes: input.maxOutputBytes,
      status: "running",
      outputBytes: 0,
      droppedBytes: 0,
      nextCursor: 1,
    };
    this.#records.set(id, record);
    child.stdout.on("data", (data: Buffer) =>
      this.#append(record, "stdout", data),
    );
    child.stderr.on("data", (data: Buffer) =>
      this.#append(record, "stderr", data),
    );
    child.once("error", (error) =>
      this.#finish(record, "spawn_error", undefined, undefined, error.message),
    );
    child.once("exit", (code, signal) => {
      const status =
        record.status === "timed_out"
          ? "timed_out"
          : record.status === "killed"
            ? "killed"
            : "exited";
      this.#finish(record, status, code ?? undefined, signal ?? undefined);
    });
    record.timeout = setTimeout(() => {
      if (record.status !== "running") return;
      record.status = "timed_out";
      record.child.kill();
    }, input.timeoutMs);
    record.timeout.unref();

    if (input.background) return this.snapshot(id, 0);
    return this.wait({ processId: id, cursor: 0, yieldMs: input.yieldMs });
  }

  public async wait(input: WaitProcessInput): Promise<ProcessSnapshot> {
    const record = this.#require(input.processId);
    if (!Number.isInteger(input.yieldMs) || input.yieldMs < 0)
      throw new Error("yieldMs must be a non-negative integer");
    if (record.status === "running" && input.yieldMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, input.yieldMs);
        const finish = (): void => done();
        function done(): void {
          clearTimeout(timer);
          record.events.off("finish", finish);
          resolve();
        }
        record.events.once("finish", finish);
      });
    }
    return this.snapshot(input.processId, input.cursor ?? 0);
  }

  public snapshot(processId: string, cursor = 0): ProcessSnapshot {
    const record = this.#require(processId);
    const oldestCursor = record.output[0]?.cursor ?? record.nextCursor;
    const truncated = cursor > 0 && cursor < oldestCursor - 1;
    return {
      processId,
      ...(record.child.pid === undefined ? {} : { pid: record.child.pid }),
      status: record.status,
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      startedAt: record.startedAt,
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      nextCursor: record.nextCursor - 1,
      truncated,
      droppedBytes: record.droppedBytes,
      output: record.output.filter((item) => item.cursor > cursor),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  }

  public writeStdin(processId: string, text: string, end = false): void {
    const record = this.#require(processId);
    if (record.status !== "running")
      throw new Error(`process is not running: ${processId}`);
    record.child.stdin.write(text, "utf8");
    if (end) record.child.stdin.end();
  }

  public stop(
    processId: string,
    signal: NodeJS.Signals = "SIGTERM",
  ): ProcessSnapshot {
    const record = this.#require(processId);
    if (record.status === "running") {
      record.status = "killed";
      record.child.kill(signal);
    }
    return this.snapshot(processId);
  }

  #append(record: ProcessRecord, channel: OutputChannel, data: Buffer): void {
    const output: ProcessOutput = {
      cursor: record.nextCursor,
      channel,
      text: data.toString("utf8"),
    };
    record.nextCursor += 1;
    record.output.push(output);
    record.outputBytes += data.byteLength;
    while (
      record.outputBytes > record.maxOutputBytes &&
      record.output.length > 0
    ) {
      const removed = record.output.shift()!;
      const bytes = Buffer.byteLength(removed.text, "utf8");
      record.outputBytes -= bytes;
      record.droppedBytes += bytes;
    }
    this.#onOutput?.(record.id, output);
  }

  #finish(
    record: ProcessRecord,
    status: ProcessStatus,
    exitCode?: number,
    signal?: NodeJS.Signals,
    error?: string,
  ): void {
    if (record.endedAt !== undefined) return;
    if (record.timeout !== undefined) clearTimeout(record.timeout);
    record.status = status;
    if (exitCode !== undefined) record.exitCode = exitCode;
    if (signal !== undefined) record.signal = signal;
    if (error !== undefined) record.error = error;
    record.endedAt = new Date().toISOString();
    record.events.emit("finish");
  }

  #require(id: string): ProcessRecord {
    const record = this.#records.get(id);
    if (record === undefined) throw new Error(`unknown process: ${id}`);
    return record;
  }
}

function validateStart(input: StartProcessInput): void {
  if (input.file.length === 0) throw new Error("process file is required");
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)
    throw new Error("timeoutMs must be positive");
  if (!Number.isFinite(input.yieldMs) || input.yieldMs < 0)
    throw new Error("yieldMs must be non-negative");
  if (!Number.isFinite(input.maxOutputBytes) || input.maxOutputBytes <= 0)
    throw new Error("maxOutputBytes must be positive");
}
