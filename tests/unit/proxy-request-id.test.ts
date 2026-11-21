// x-request-id response header (src/proxy.ts).
//
// Every response the proxy produces — pass-through, redirect, and CSRF
// rejection — carries a fresh random UUID in x-request-id, so a client
// or operator can quote it when correlating a failure with server logs.
// The id carries no user data.
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockGetToken } = vi.hoisted(() => ({ mockGetToken: vi.fn() }));

vi.mock("next-auth/jwt", () => ({ getToken: mockGetToken }));

import { proxy } from "@/proxy";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("proxy x-request-id", () => {
  it("sets a UUID request id on a pass-through API response", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/api/cart"));
    expect(res.headers.get("x-request-id")).toMatch(UUID_RE);
  });

  it("issues a different id per request", async () => {
    const a = await proxy(new NextRequest("http://localhost:3000/api/cart"));
    const b = await proxy(new NextRequest("http://localhost:3000/api/cart"));
    expect(a.headers.get("x-request-id")).toMatch(UUID_RE);
    expect(b.headers.get("x-request-id")).toMatch(UUID_RE);
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
  });

  it("sets the id on the unauthenticated admin redirect too", async () => {
    mockGetToken.mockResolvedValue(null);
    const res = await proxy(new NextRequest("http://localhost:3000/admin/products"));
    expect(res.status).toBe(307);
    expect(res.headers.get("x-request-id")).toMatch(UUID_RE);
  });

  it("sets the id on a CSRF rejection", async () => {
    const res = await proxy(
      new NextRequest("http://localhost:3000/api/cart", {
        method: "POST",
        headers: { origin: "https://evil.example.com" },
      })
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("x-request-id")).toMatch(UUID_RE);
  });
});
