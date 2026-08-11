export interface HttpFetchInput {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpFetchResult {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly redirects: readonly string[];
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const OMITTED_HEADERS = new Set([
  "set-cookie",
  "proxy-authenticate",
  "www-authenticate",
]);

export async function fetchWebContent(
  input: HttpFetchInput,
): Promise<HttpFetchResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxBytes = input.maxBytes ?? 2_000_000;
  const maxRedirects = input.maxRedirects ?? 5;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("timeoutMs must be a positive integer");
  if (!Number.isInteger(maxBytes) || maxBytes <= 0)
    throw new Error("maxBytes must be a positive integer");
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0)
    throw new Error("maxRedirects must be non-negative");

  const requested = checkedUrl(input.url);
  let current = requested;
  const redirects: string[] = [];
  for (;;) {
    const response = await fetch(current, {
      redirect: "manual",
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (REDIRECT_CODES.has(response.status)) {
      const location = response.headers.get("location");
      if (location === null)
        throw new Error(
          `redirect ${response.status} did not include a Location header`,
        );
      if (redirects.length >= maxRedirects)
        throw new Error(`redirect limit exceeded: ${maxRedirects}`);
      current = checkedUrl(new URL(location, current).toString());
      redirects.push(current.toString());
      continue;
    }

    const { body, bytesRead, truncated } = await readBounded(
      response,
      maxBytes,
    );
    return {
      requestedUrl: requested.toString(),
      finalUrl: current.toString(),
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      headers: safeHeaders(response.headers),
      body,
      bytesRead,
      truncated,
      redirects,
    };
  }
}

function checkedUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("only http and https URLs are supported");
  return url;
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; bytesRead: number; truncated: boolean }> {
  if (response.body === null)
    return { body: "", bytesRead: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (bytesRead + value.byteLength > maxBytes) {
        const remaining = maxBytes - bytesRead;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        bytesRead += Math.max(remaining, 0);
        truncated = true;
        await reader.cancel("response exceeded maxBytes");
        break;
      }
      chunks.push(value);
      bytesRead += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(bytes), bytesRead, truncated };
}

function safeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (!OMITTED_HEADERS.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}
