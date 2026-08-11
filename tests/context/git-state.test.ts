import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { collectGitState } from "../../src/context/git-state.js";

const execFileAsync = promisify(execFile);

describe("collectGitState", () => {
  it("records exact HEAD, branch, status, and modified files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmsh-git-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "TMSH Test"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: root, windowsHide: true });
    await writeFile(join(root, "tracked.txt"), "one\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root, windowsHide: true });
    await writeFile(join(root, "tracked.txt"), "changed\n", "utf8");
    await writeFile(join(root, "new file.txt"), "new\n", "utf8");

    const state = await collectGitState(root, ["event-10"], new Date("2026-08-11T01:00:00.000Z"));
    expect(state.value.available).toBe(true);
    expect(state.value.branch).toBe("main");
    expect(state.value.head).toMatch(/^[a-f0-9]{40}$/);
    expect(state.value.status).toContain(" M tracked.txt");
    expect(state.value.modifiedFiles).toEqual(["new file.txt", "tracked.txt"]);
  });

  it("preserves explicit unavailability instead of inventing state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmsh-no-git-"));
    const state = await collectGitState(root, [], new Date("2026-08-11T01:00:00.000Z"));
    expect(state.value).toMatchObject({ available: false, head: "", branch: "", status: "", modifiedFiles: [] });
    expect(state.value.error).toBeTruthy();
  });
});
