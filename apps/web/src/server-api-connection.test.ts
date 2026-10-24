import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchApiTransport } from "./server-api-transport";
import { apiFetch } from "./server-api";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected isolated TCP fixture");
  return `http://127.0.0.1:${address.port}`;
}

describe("real loopback API connection recovery", () => {
  it("loads research after two dropped connections with authorization intact", async () => {
    vi.stubEnv("WEB_AUTH_MODE", "local-service");
    vi.stubEnv("API_ACCESS_TOKEN", "synthetic-local-test");
    let attempts = 0;
    const paths: string[] = [],
      authorizations: (string | undefined)[] = [];
    const url = await listen(
      createServer((request, response) => {
        attempts++;
        paths.push(request.url!);
        authorizations.push(request.headers.authorization);
        if (attempts <= 2) {
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ items: [], total: 0, nextCursor: null }));
      }),
    );
    const response = await apiFetch(`${url}/v1/research-items?q=synthetic&visibility=active`, {
      cache: "no-store",
    });
    expect(await response.json()).toEqual({ items: [], total: 0, nextCursor: null });
    expect(attempts).toBe(3);
    expect(new Set(paths).size).toBe(1);
    expect(authorizations).toEqual(Array(3).fill("Bearer synthetic-local-test"));
  });

  it("does not duplicate a mutation whose server accepted the body then dropped its response", async () => {
    let writes = 0;
    const url = await listen(
      createServer(async (request) => {
        for await (const chunk of request) void chunk;
        writes++;
        request.socket.destroy();
      }),
    );
    await expect(
      fetchApiTransport(url, { method: "POST", body: "synthetic mutation" }),
    ).rejects.toThrow("数据服务暂时无法连接");
    expect(writes).toBe(1);
  });
});
