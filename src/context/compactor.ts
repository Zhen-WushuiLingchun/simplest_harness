import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "../core/types.js";
import { canonicalJson, sha256Json } from "./canonical.js";
import { verifyLedgerSnapshot } from "./ledger.js";
import {
  compactionCandidateSchema,
  type CompactionArtifact,
  type CompactionCandidate,
  type CompactionSource,
  type LedgerSnapshot,
} from "./schema.js";

export interface CompactRequest {
  readonly runId: string;
  readonly messages: readonly JsonValue[];
  readonly recentTurns: number;
  readonly ledger: LedgerSnapshot;
  readonly source: CompactionSource;
}

export type Summarizer = (request: CompactRequest) => Promise<unknown>;

export type CompactionResult =
  | {
      readonly accepted: true;
      readonly artifact: CompactionArtifact;
      readonly artifactPath: string;
    }
  | { readonly accepted: false; readonly reasons: readonly string[] };

export class ContextCompactor {
  readonly #root: string;
  readonly #summarize: Summarizer;

  public constructor(root: string, summarize: Summarizer) {
    this.#root = root;
    this.#summarize = summarize;
  }

  public async compact(request: CompactRequest): Promise<CompactionResult> {
    let liveLedger: LedgerSnapshot;
    try {
      liveLedger = verifyLedgerSnapshot(request.ledger);
    } catch (error) {
      return { accepted: false, reasons: [messageOf(error)] };
    }

    let untrusted: unknown;
    try {
      untrusted = await this.#summarize(request);
    } catch (error) {
      return {
        accepted: false,
        reasons: [`summarizer failed: ${messageOf(error)}`],
      };
    }

    const checked = validateCompactionCandidate(
      untrusted,
      liveLedger,
      request.source,
    );
    if (!checked.ok) return { accepted: false, reasons: checked.reasons };

    const tailCount = Math.max(0, request.recentTurns * 2);
    const recentTail = request.messages.slice(
      Math.max(0, request.messages.length - tailCount),
    );
    const body = {
      version: 1 as const,
      createdAt: new Date().toISOString(),
      summary: checked.candidate.summary,
      ledger: liveLedger,
      recentTail,
      source: request.source,
    };
    const artifact: CompactionArtifact = {
      ...body,
      artifactDigest: sha256Json(body as JsonValue),
    };
    const artifactPath = join(
      this.#root,
      "runs",
      request.runId,
      "compactions",
      `${request.source.throughSeq}-${artifact.artifactDigest.slice(0, 12)}.json`,
    );
    try {
      await writeJsonAtomic(artifactPath, artifact as unknown as JsonValue);
    } catch (error) {
      return {
        accepted: false,
        reasons: [`artifact write failed: ${messageOf(error)}`],
      };
    }
    return { accepted: true, artifact, artifactPath };
  }
}

export function validateCompactionCandidate(
  input: unknown,
  liveLedger: LedgerSnapshot,
  expectedSource: CompactionSource,
):
  | { readonly ok: true; readonly candidate: CompactionCandidate }
  | { readonly ok: false; readonly reasons: string[] } {
  const parsed = compactionCandidateSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      reasons: parsed.error.issues.map((issue) => issue.message),
    };

  const reasons: string[] = [];
  try {
    verifyLedgerSnapshot(parsed.data.ledger);
  } catch (error) {
    reasons.push(messageOf(error));
  }
  if (
    canonicalJson(parsed.data.ledger as JsonValue) !==
    canonicalJson(liveLedger as JsonValue)
  ) {
    reasons.push("candidate ledger does not exactly match the live ledger");
  }
  if (
    canonicalJson(parsed.data.source as JsonValue) !==
    canonicalJson(expectedSource as JsonValue)
  ) {
    reasons.push(
      "candidate source does not match the requested event boundary",
    );
  }
  return reasons.length === 0
    ? { ok: true, candidate: parsed.data }
    : { ok: false, reasons };
}

export async function writeJsonAtomic(
  path: string,
  value: JsonValue,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
