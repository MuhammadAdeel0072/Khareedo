// API route helpers — consistent JSON responses, auth guards, error handling.
import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";
import { AuthError } from "@/lib/auth-guard";

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, ...data }, init);
}

export function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}

/** Parse + validate a JSON body with a zod schema; returns parsed or a Response. */
export async function parseBody<T>(
  request: Request,
  schema: ZodSchema<T>
): Promise<{ data: T; error?: never } | { data?: never; error: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { error: jsonError("Invalid request body", 400) };
  }
  try {
    return { data: schema.parse(raw) };
  } catch (e) {
    if (e instanceof ZodError) {
      const errors: Record<string, string> = {};
      for (const issue of e.issues) {
        const key = issue.path.join(".") || "_";
        if (!errors[key]) errors[key] = issue.message;
      }
      return { error: jsonError("Please correct the highlighted fields.", 422, { errors }) };
    }
    return { error: jsonError("Invalid request", 400) };
  }
}

/** Wrap a route handler with uniform error handling (NFR-05). */
export function handleRoute(fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((e) => {
    if (e instanceof AuthError) return jsonError(e.message, e.status);
    console.error("[api] unhandled error:", e);
    return jsonError("Something went wrong. Please try again.", 500);
  });
}
