import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PreservationLedger } from "../../src/context/ledger.js";
import {
  SessionStore,
  sessionTranscript,
} from "../../src/core/session-store.js";

describe("SessionStore", () => {
  it("atomically preserves messages and the exact ledger for resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmsh-session-"));
    const workspace = join(root, "project");
    const store = new SessionStore(join(root, ".tmsh"));
    const created = await store.create({
      title: "  Resume   this conversation  ",
      workspace,
      modelId: "main",
    });
    const ledger = new PreservationLedger();
    ledger.upsert({
      id: "risk.resume",
      category: "correctness_risk",
      value: {
        risk: "resume smoke risk",
        evidence: "session test",
        impact: "test only",
      },
      sourceEventIds: ["event-1"],
      updatedAt: "2026-08-11T00:00:00.000Z",
    });
    await store.saveState(created.id, {
      modelId: "reviewer",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
      ledger: ledger.snapshot(),
    });

    const resumed = await store.resolve(created.id.slice(0, 8), workspace);
    expect(resumed).toMatchObject({
      id: created.id,
      title: "Resume this conversation",
      modelId: "reviewer",
    });
    expect(resumed.ledger.sections.correctness_risk[0]?.value).toEqual({
      risk: "resume smoke risk",
      evidence: "session test",
      impact: "test only",
    });
    expect(sessionTranscript(resumed)).toContain("[assistant] first answer");
    await expect(store.list(workspace)).resolves.toHaveLength(1);
    await expect(store.list(join(root, "other"))).resolves.toHaveLength(0);
  });

  it("rejects a session whose ledger digest was changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmsh-session-bad-"));
    const store = new SessionStore(join(root, ".tmsh"));
    const created = await store.create({
      title: "digest",
      workspace: root,
      modelId: "main",
    });
    const raw = JSON.parse(await readFile(store.path(created.id), "utf8")) as {
      ledger: { digest: string };
    };
    raw.ledger.digest = "0".repeat(64);
    await writeFile(store.path(created.id), JSON.stringify(raw), "utf8");
    await expect(store.load(created.id)).rejects.toThrow(
      "ledger digest mismatch",
    );
  });
});
