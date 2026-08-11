import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { z } from "zod";
import type { gitStateEntrySchema } from "./schema.js";

const execFileAsync = promisify(execFile);

export type GitStateEntry = z.infer<typeof gitStateEntrySchema>;

export async function collectGitState(
  workdir: string,
  sourceEventIds: readonly string[],
  now = new Date(),
): Promise<GitStateEntry> {
  try {
    const [head, branch, status, statusZero] = await Promise.all([
      git(["rev-parse", "HEAD"], workdir),
      git(["branch", "--show-current"], workdir),
      git(["status", "--porcelain=v1", "--untracked-files=all"], workdir),
      git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], workdir),
    ]);
    return {
      id: "git.current",
      category: "git_state",
      sourceEventIds: [...sourceEventIds],
      updatedAt: now.toISOString(),
      value: {
        available: true,
        head: trimOneNewline(head),
        branch: trimOneNewline(branch),
        status: trimOneNewline(status),
        modifiedFiles: parseStatusPaths(statusZero),
      },
    };
  } catch (error) {
    return {
      id: "git.current",
      category: "git_state",
      sourceEventIds: [...sourceEventIds],
      updatedAt: now.toISOString(),
      value: {
        available: false,
        head: "",
        branch: "",
        status: "",
        modifiedFiles: [],
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function git(args: readonly string[], workdir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workdir,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 2_000_000,
  });
  return stdout;
}

function trimOneNewline(value: string): string {
  return value.replace(/\r?\n$/u, "");
}

function parseStatusPaths(status: string): string[] {
  const records = status.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    paths.add(record.slice(3));
    if (code.includes("R") || code.includes("C")) {
      const priorPath = records[index + 1];
      if (priorPath !== undefined && priorPath.length > 0) {
        paths.add(priorPath);
        index += 1;
      }
    }
  }
  return [...paths].sort();
}
