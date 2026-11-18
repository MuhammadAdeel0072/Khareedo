// Unit tests for GET /api/db-target (PR-07): the endpoint reports only
// whether the app's database target is loopback — no credentials, no
// hostname, no connection details — and never connects to the database.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/db-target/route";

const ENV_KEY = "SUPABASE_POSTGRES_URL";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

async function body() {
  const response = await GET();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return (await response.json()) as { databaseIsLoopback: unknown };
}

describe("GET /api/db-target", () => {
  it("reports true for a loopback database", async () => {
    process.env[ENV_KEY] = "postgresql://postgres:secret@localhost:5432/postgres";
    expect(await body()).toEqual({ databaseIsLoopback: true });
  });

  it("reports false for a remote database", async () => {
    process.env[ENV_KEY] =
      "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres";
    expect(await body()).toEqual({ databaseIsLoopback: false });
  });

  it("reports false when the variable is missing or malformed", async () => {
    delete process.env[ENV_KEY];
    expect(await body()).toEqual({ databaseIsLoopback: false });
    process.env[ENV_KEY] = "postgresql://[::1";
    expect(await body()).toEqual({ databaseIsLoopback: false });
  });

  it("reports false for a loopback host overridden by a query parameter", async () => {
    process.env[ENV_KEY] =
      "postgresql://postgres:secret@localhost:5432/postgres?host=db.example.supabase.co";
    expect(await body()).toEqual({ databaseIsLoopback: false });
  });

  it("exposes nothing but the boolean", async () => {
    process.env[ENV_KEY] =
      "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres";
    const response = await GET();
    const text = await response.text();
    expect(text).toBe(JSON.stringify({ databaseIsLoopback: false }));
    expect(text).not.toContain("secret");
    expect(text).not.toContain("supabase.co");
  });
});
