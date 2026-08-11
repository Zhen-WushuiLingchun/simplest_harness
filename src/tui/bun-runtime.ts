import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function findBunBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const executable = platform === "win32" ? "bun.exe" : "bun";
  const candidates: string[] = [];
  if (env.TMSH_BUN_PATH !== undefined) candidates.push(env.TMSH_BUN_PATH);
  if (env.BUN_INSTALL !== undefined)
    candidates.push(join(env.BUN_INSTALL, "bin", executable));
  if (env.USERPROFILE !== undefined)
    candidates.push(join(env.USERPROFILE, ".bun", "bin", executable));
  const pathDelimiter = platform === "win32" ? ";" : ":";
  for (const directory of (env.PATH ?? "")
    .split(pathDelimiter)
    .filter(Boolean)) {
    candidates.push(join(directory, executable));
    if (platform === "win32")
      candidates.push(
        join(directory, "node_modules", "bun", "bin", executable),
      );
  }
  return [...new Set(candidates)].find(exists);
}

export function shouldRelaunchTuiWithBun(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly stdinTty?: boolean;
    readonly stdoutTty?: boolean;
    readonly bunRuntime?: boolean;
  } = {},
): boolean {
  const env = input.env ?? process.env;
  if (input.bunRuntime ?? "bun" in process.versions) return false;
  if (env.TMSH_BUN_REEXEC === "1" || env.TMSH_DISABLE_BUN_REEXEC === "1")
    return false;
  if (env.TMSH_FORCE_NATIVE_TUI === "1") return true;
  return (
    (input.stdinTty ?? Boolean(process.stdin.isTTY)) &&
    (input.stdoutTty ?? Boolean(process.stdout.isTTY))
  );
}

export function relaunchTuiWithBun(
  argv: readonly string[],
  entry = process.argv[1],
): number | undefined {
  if (!shouldRelaunchTuiWithBun() || entry === undefined) return undefined;
  const bun = findBunBinary();
  if (bun === undefined) return undefined;
  const result = spawnSync(bun, [entry, ...argv], {
    stdio: "inherit",
    env: { ...process.env, TMSH_BUN_REEXEC: "1" },
  });
  if (result.error !== undefined) {
    process.stderr.write(
      `[TMSH] Bun re-exec failed; continuing with Node fallback: ${result.error.message}\n`,
    );
    return undefined;
  }
  return result.status ?? 1;
}
