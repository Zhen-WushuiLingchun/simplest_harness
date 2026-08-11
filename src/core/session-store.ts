import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { PreservationLedger } from "../context/ledger.js";
import { sha256Json } from "../context/canonical.js";
import {
  ledgerSnapshotSchema,
  type LedgerSnapshot,
} from "../context/schema.js";
import type { JsonValue } from "./types.js";

const MAX_SESSION_BYTES = 20_000_000;
const sessionSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    title: z.string().min(1).max(160),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    workspace: z.string().min(1),
    modelId: z.string().min(1),
    messages: z.array(z.unknown()),
    ledger: ledgerSnapshotSchema,
  })
  .strict();

export interface SessionRecord {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly workspace: string;
  readonly modelId: string;
  readonly messages: readonly ModelMessage[];
  readonly ledger: LedgerSnapshot;
}

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly workspace: string;
  readonly modelId: string;
  readonly messageCount: number;
}

export class SessionStore {
  readonly #root: string;
  readonly #queues = new Map<string, Promise<unknown>>();

  public constructor(dataDir: string) {
    this.#root = join(dataDir, "sessions");
  }

  public path(id: string): string {
    assertSessionId(id);
    return join(this.#root, `${id}.json`);
  }

  public async create(input: {
    readonly title: string;
    readonly workspace: string;
    readonly modelId: string;
  }): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      version: 1,
      id: randomUUID(),
      title: normalizeTitle(input.title),
      createdAt: now,
      updatedAt: now,
      workspace: resolve(input.workspace),
      modelId: input.modelId,
      messages: [],
      ledger: new PreservationLedger().snapshot(),
    };
    await this.#write(record);
    return record;
  }

  public async load(id: string): Promise<SessionRecord> {
    const path = this.path(id);
    const info = await stat(path);
    if (info.size > MAX_SESSION_BYTES)
      throw new Error(`session exceeds ${MAX_SESSION_BYTES} bytes: ${id}`);
    return parseSession(JSON.parse(await readFile(path, "utf8")));
  }

  public async list(workspace?: string): Promise<SessionSummary[]> {
    let names: string[];
    try {
      names = (await readdir(this.#root, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const expectedWorkspace =
      workspace === undefined ? undefined : resolve(workspace);
    const records: SessionSummary[] = [];
    for (const name of names) {
      const id = name.slice(0, -".json".length);
      if (!isSessionId(id)) continue;
      try {
        const record = await this.load(id);
        if (
          expectedWorkspace !== undefined &&
          record.workspace !== expectedWorkspace
        )
          continue;
        records.push(summary(record));
      } catch {
        // Invalid session files are not partially surfaced by the listing.
      }
    }
    return records.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  public async resolve(
    reference: string,
    workspace?: string,
  ): Promise<SessionRecord> {
    const normalized = reference.trim().toLowerCase();
    if (!/^[a-f0-9-]{4,36}$/u.test(normalized))
      throw new Error("session reference must be a UUID or prefix of 4+ chars");
    const matches = (await this.list(workspace)).filter((item) =>
      item.id.startsWith(normalized),
    );
    if (matches.length === 0)
      throw new Error(`session not found: ${reference}`);
    if (matches.length > 1)
      throw new Error(`session prefix is ambiguous: ${reference}`);
    return this.load(matches[0]!.id);
  }

  public async saveState(
    id: string,
    input: {
      readonly modelId: string;
      readonly messages: readonly ModelMessage[];
      readonly ledger: LedgerSnapshot;
    },
  ): Promise<SessionRecord> {
    return this.#enqueue(id, async () => {
      const previous = await this.load(id);
      const record: SessionRecord = {
        ...previous,
        updatedAt: new Date().toISOString(),
        modelId: input.modelId,
        messages: structuredClone(input.messages),
        ledger: input.ledger,
      };
      const parsed = parseSession(record);
      await this.#write(parsed);
      return parsed;
    });
  }

  async #write(record: SessionRecord): Promise<void> {
    const path = this.path(record.id);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  }

  async #enqueue<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const current = previous.then(work);
    this.#queues.set(
      id,
      current.catch(() => undefined),
    );
    return current;
  }
}

export function sessionTranscript(
  record: SessionRecord,
  maxMessages = 24,
  maxChars = 40_000,
): string {
  const lines = record.messages.slice(-maxMessages).flatMap((message) => {
    const text = messageText(message);
    return text.length === 0 ? [] : [`[${message.role}] ${text}`];
  });
  if (lines.length === 0) return "[session has no completed messages]";
  const transcript = lines.join("\n");
  return transcript.length <= maxChars
    ? transcript
    : `[older session preview omitted; complete state remains on disk]\n${transcript.slice(-maxChars)}`;
}

export function sessionStateDigest(record: SessionRecord): string {
  return sha256Json({
    version: record.version,
    id: record.id,
    messages: record.messages,
    ledger: record.ledger,
  } as unknown as JsonValue);
}

function parseSession(input: unknown): SessionRecord {
  const parsed = sessionSchema.parse(input);
  const messages = parsed.messages.map(parseMessage);
  const ledger = ledgerSnapshotSchema.parse(parsed.ledger);
  new PreservationLedger().load(ledger);
  return { ...parsed, messages, ledger };
}

function parseMessage(input: unknown): ModelMessage {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("session message must be an object");
  const role = (input as { role?: unknown }).role;
  if (
    role !== "system" &&
    role !== "user" &&
    role !== "assistant" &&
    role !== "tool"
  )
    throw new Error(`invalid session message role: ${String(role)}`);
  return structuredClone(input) as ModelMessage;
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) => {
      if (
        part !== null &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      )
        return [part.text];
      return [];
    })
    .join("\n");
}

function summary(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    workspace: record.workspace,
    modelId: record.modelId,
    messageCount: record.messages.length,
  };
}

function normalizeTitle(value: string): string {
  const title = value.trim().replace(/\s+/gu, " ").slice(0, 160);
  return title.length === 0 ? "Untitled session" : title;
}

function assertSessionId(id: string): void {
  if (!isSessionId(id)) throw new Error(`invalid session id: ${id}`);
}

function isSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    id,
  );
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
