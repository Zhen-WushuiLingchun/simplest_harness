import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveConfig, type DeepPartial, type TmshConfig } from "./config.js";

export interface LoadedConfig {
  readonly config: TmshConfig;
  readonly source?: string;
}

export async function loadConfig(
  cwd: string,
  explicitPath?: string,
): Promise<LoadedConfig> {
  const candidates =
    explicitPath === undefined
      ? [join(cwd, "tmsh.local.json"), join(cwd, "tmsh.json")]
      : [isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath)];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(
        await readFile(path, "utf8"),
      ) as DeepPartial<TmshConfig>;
      const base = dirname(path);
      const config = resolveConfig({
        ...parsed,
        dataDir: resolve(base, parsed.dataDir ?? ".tmsh"),
      });
      return { config, source: path };
    } catch (error) {
      if (isMissing(error) && explicitPath === undefined) continue;
      if (error instanceof SyntaxError)
        throw new Error(`invalid JSON config ${path}: ${error.message}`);
      throw error;
    }
  }
  return { config: resolveConfig({ dataDir: resolve(cwd, ".tmsh") }) };
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
