import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRunSession } from "../src/cli.js";
import { SessionStore } from "../src/core/session-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CLI run sessions", () => {
  it("creates a durable session for every new CLI run", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmsh-cli-session-"));
    temporaryDirectories.push(root);
    const sessions = new SessionStore(join(root, "data"));

    const selected = await prepareRunSession({
      sessions,
      workspace: root,
      goal: "finish the benchmark task",
      defaultModelId: "direct/deepseek-v4-flash",
    });

    const saved = await sessions.load(selected.sessionId);
    expect(selected.modelId).toBe("direct/deepseek-v4-flash");
    expect(saved.title).toBe("finish the benchmark task");
    expect(saved.workspace).toBe(root);
  });

  it("resumes by UUID prefix and preserves the session model by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmsh-cli-resume-"));
    temporaryDirectories.push(root);
    const sessions = new SessionStore(join(root, "data"));
    const saved = await sessions.create({
      title: "existing work",
      workspace: root,
      modelId: "direct/deepseek-v4-flash",
    });

    const selected = await prepareRunSession({
      sessions,
      workspace: root,
      goal: "continue from the exact saved state",
      resumeReference: saved.id.slice(0, 8),
    });

    expect(selected).toEqual({
      sessionId: saved.id,
      modelId: "direct/deepseek-v4-flash",
    });
  });
});
