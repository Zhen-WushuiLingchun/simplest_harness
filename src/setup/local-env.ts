import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function localEnvPath(directory: string): string {
  return join(directory, "tmsh.local.env");
}

export async function loadLocalEnvironment(
  directory: string,
): Promise<{ readonly path: string; readonly loaded: readonly string[] }> {
  const path = localEnvPath(directory);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { path, loaded: [] };
    throw error;
  }
  const values = parseLocalEnvironment(text);
  const loaded: string[] = [];
  for (const [name, value] of values) {
    if (process.env[name] !== undefined) continue;
    process.env[name] = value;
    loaded.push(name);
  }
  return { path, loaded };
}

export async function saveLocalSecret(
  directory: string,
  name: string,
  value: string,
): Promise<string> {
  if (!NAME.test(name)) throw new Error(`invalid environment name: ${name}`);
  if (value.length === 0) throw new Error("API key must not be empty");
  const path = localEnvPath(directory);
  let values = new Map<string, string>();
  try {
    values = parseLocalEnvironment(await readFile(path, "utf8"));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  values.set(name, value);
  const content = `${[...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([entryName, entryValue]) => `${entryName}=${JSON.stringify(entryValue)}`,
    )
    .join("\n")}\n`;
  await writePrivateAtomic(path, content);
  process.env[name] = value;
  return path;
}

export function parseLocalEnvironment(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const [index, original] of text.split(/\r?\n/u).entries()) {
    const line = original.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1)
      throw new Error(`invalid local environment line ${index + 1}`);
    const name = line.slice(0, separator);
    if (!NAME.test(name))
      throw new Error(`invalid environment name at line ${index + 1}`);
    let value: unknown;
    try {
      value = JSON.parse(line.slice(separator + 1));
    } catch {
      throw new Error(
        `local environment value must be a JSON string at line ${index + 1}`,
      );
    }
    if (typeof value !== "string")
      throw new Error(
        `local environment value must be a JSON string at line ${index + 1}`,
      );
    if (result.has(name))
      throw new Error(`duplicate local environment name: ${name}`);
    result.set(name, value);
  }
  return result;
}

async function writePrivateAtomic(
  path: string,
  content: string,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
