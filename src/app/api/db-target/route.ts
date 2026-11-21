// GET /api/db-target — reports whether the app's database target is loopback.
//
// Dev-audit support (PR-07): the concurrency audit script verifies the app
// it talks to is connected to a local database before creating any rows.
// A localhost base URL alone proves nothing about the app's database — the
// dev server may have been started against production Supabase — so the app
// answers for itself here.
//
// The response carries only one boolean. It never includes credentials, a
// hostname, a connection string, or any other connection detail. It does
// not connect to the database: it only parses SUPABASE_POSTGRES_URL, so it
// answers even when the database is unreachable.
//
// Stage 3 audit, L-4: the endpoint is dev-audit scaffolding, so it is
// gated to non-production environments — in production it answers 404,
// exactly like a route that does not exist, so it reveals nothing about
// the deployment topology. The audit scripts that consume it
// (scripts/audit-concurrency.mjs and friends) only ever run against a
// local dev server (NODE_ENV=development), so the gate does not break
// them; see docs/SQL-SAFETY.md.
import { NextResponse } from "next/server";
import { isLoopbackPostgresUrl } from "@/lib/db-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { ok: false, error: "Not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { databaseIsLoopback: isLoopbackPostgresUrl(process.env.SUPABASE_POSTGRES_URL) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
