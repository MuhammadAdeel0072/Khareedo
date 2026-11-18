// Unit tests for verifyAppDatabaseTarget (PR-07 fix): the audit script's
// server-side check that the app it talks to is connected to a loopback
// database. Tested against a local stub server standing in for the app's
// GET /api/db-target endpoint.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { verifyAppDatabaseTarget } from "../../scripts/db-target-guards.mjs";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function startStub(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("verifyAppDatabaseTarget", () => {
  it("accepts an app reporting a loopback database", async () => {
    const base = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ databaseIsLoopback: true }));
    });
    await expect(verifyAppDatabaseTarget(base)).resolves.toEqual({ status: "ok" });
  });

  it("refuses an app reporting a remote database", async () => {
    const base = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ databaseIsLoopback: false }));
    });
    const result = await verifyAppDatabaseTarget(base);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toContain("not connected to a loopback database");
    }
  });

  it("refuses when the endpoint is missing (404)", async () => {
    const base = await startStub((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    const result = await verifyAppDatabaseTarget(base);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toContain("cannot be verified");
    }
  });

  it("refuses an unreadable response", async () => {
    const base = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("this is not json");
    });
    expect((await verifyAppDatabaseTarget(base)).status).toBe("refused");
  });

  it("refuses a non-boolean verdict", async () => {
    const base = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ databaseIsLoopback: "yes" }));
    });
    expect((await verifyAppDatabaseTarget(base)).status).toBe("refused");
  });

  it("refuses an unreachable app", async () => {
    // Bind a port, then close it, so nothing is listening there.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()));
    const address = closed.address();
    if (!address || typeof address === "string") throw new Error("did not bind");
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await verifyAppDatabaseTarget(`http://127.0.0.1:${address.port}`);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toContain("could not reach");
    }
  });
});
