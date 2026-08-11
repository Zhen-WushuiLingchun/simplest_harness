import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWebContent } from "../../src/tools/http-fetch.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing test address");
  return `http://127.0.0.1:${address.port}`;
}

describe("fetchWebContent", () => {
  it("follows bounded redirects and strips authentication response headers", async () => {
    const base = await serve((request, response) => {
      if (request.url === "/from") {
        response.writeHead(302, { location: "/to" }).end();
        return;
      }
      response
        .writeHead(200, {
          "content-type": "text/plain",
          "set-cookie": "secret=1",
        })
        .end("observed body");
    });
    const result = await fetchWebContent({ url: `${base}/from` });
    expect(result).toMatchObject({
      status: 200,
      body: "observed body",
      truncated: false,
    });
    expect(result.redirects).toEqual([`${base}/to`]);
    expect(result.headers["set-cookie"]).toBeUndefined();
  });

  it("bounds response bytes and rejects non-http protocols", async () => {
    const base = await serve((_request, response) =>
      response.end("0123456789"),
    );
    const result = await fetchWebContent({ url: base, maxBytes: 4 });
    expect(result).toMatchObject({
      body: "0123",
      bytesRead: 4,
      truncated: true,
    });
    await expect(
      fetchWebContent({ url: "file:///etc/passwd" }),
    ).rejects.toThrow(/http and https/);
  });
});
