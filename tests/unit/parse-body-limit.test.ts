// parseBody request-body size cap (src/lib/api.ts).
//
// A JSON body above MAX_JSON_BODY_BYTES (1 MiB) is rejected with 413
// before it is parsed or validated — both when the client declares its
// size up front (Content-Length) and when it does not (chunked/streamed
// body, enforced on the bytes actually received). Legitimate bodies are
// far below the bound (longest schema field: 5,000-char description).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_JSON_BODY_BYTES, parseBody } from "@/lib/api";

const schema = z.object({ name: z.string().min(1) });

function postJson(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("parseBody size cap", () => {
  it("accepts a normal body and validates it", async () => {
    const { data, error } = await parseBody(postJson(JSON.stringify({ name: "Widget" })), schema);
    expect(error).toBeUndefined();
    expect(data).toEqual({ name: "Widget" });
  });

  it("rejects an oversized body declared via Content-Length with 413", async () => {
    const big = JSON.stringify({ name: "x".repeat(MAX_JSON_BODY_BYTES) });
    const { error } = await parseBody(postJson(big), schema);
    expect(error).toBeDefined();
    expect(error?.status).toBe(413);
    expect((await error?.json()) as { error: string }).toMatchObject({
      error: "Request body is too large.",
    });
  });

  it("rejects an oversized body without Content-Length (chunked) with 413", async () => {
    const big = JSON.stringify({ name: "x".repeat(MAX_JSON_BODY_BYTES) });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // @ts-expect-error duplex is required for stream bodies in Node
      duplex: "half",
    });
    expect(req.headers.get("content-length")).toBeNull();
    const { error } = await parseBody(req, schema);
    expect(error?.status).toBe(413);
  });

  it("rejects a body above a caller-supplied maxBytes", async () => {
    const { error } = await parseBody(
      postJson(JSON.stringify({ name: "x".repeat(100) })),
      schema,
      { maxBytes: 50 }
    );
    expect(error?.status).toBe(413);
  });

  it("still reports invalid JSON as 400 and schema failures as 422", async () => {
    const badJson = await parseBody(postJson("{not json"), schema);
    expect(badJson.error?.status).toBe(400);
    const badSchema = await parseBody(postJson(JSON.stringify({ name: "" })), schema);
    expect(badSchema.error?.status).toBe(422);
  });

  it("measures multi-byte characters in bytes, not code units", async () => {
    // "é" is 1 UTF-16 code unit but 2 UTF-8 bytes: a body of 60 é's is
    // 60 chars but 120 bytes, so a 100-byte cap must reject it.
    const { error } = await parseBody(
      postJson(JSON.stringify({ name: "é".repeat(60) })),
      schema,
      { maxBytes: 100 }
    );
    expect(error?.status).toBe(413);
  });
});
