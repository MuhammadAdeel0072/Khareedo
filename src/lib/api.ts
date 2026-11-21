// API route helpers — consistent JSON responses, auth guards, error handling.
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";
import { Prisma } from "../../generated/postgres-client";
import { AuthError, MfaRequiredError } from "@/lib/auth-guard";
import { captureError } from "@/lib/error-monitoring";
import { getPerformanceRequestId } from "@/lib/performance-timing";

/** The proxy stamps every request with a random UUID (src/proxy.ts). Only
 *  that shape is accepted here: a client-supplied x-request-id that is not
 *  a UUID is ignored, so a crafted header can never inject newlines or
 *  arbitrary text into the structured error log (the proxy overwrites the
 *  header on the normal path, but the app server may be directly
 *  reachable — Q-01 — so the check-in here is the defence in depth). */
const REQUEST_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function asRequestId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Resolve the request id for error capture, in priority order:
 *  1. the id on the request passed to handleRoute (the proxy's id, read
 *     straight off the incoming headers — no async work);
 *  2. `headers()` (Next 16: async) — the same proxy-set id, for the
 *     existing call sites that do not pass their request. This is what
 *     wires the proxy id into captureError without touching ~60 route
 *     files; outside a request scope it throws and is ignored;
 *  3. the withPerformanceTiming ALS id (or its per-request cached id) —
 *     the pre-existing fallback, unchanged.
 *  Only ever called on the error path, so the headers() await costs
 *  nothing on a healthy request. */
export async function resolveRequestId(request?: Request): Promise<string> {
  return (
    asRequestId(request?.headers.get("x-request-id")) ??
    (await readProxyRequestIdFromHeaders()) ??
    getPerformanceRequestId()
  );
}

async function readProxyRequestIdFromHeaders(): Promise<string | undefined> {
  try {
    return asRequestId((await headers()).get("x-request-id"));
  } catch {
    // Outside a Next request scope (unit tests, scripts): no header to read.
    return undefined;
  }
}

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, ...data }, init);
}

export function jsonError(message: string, status = 400, extra?: Record<string, unknown>, init?: ResponseInit) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status, ...init });
}

/** Maximum JSON request body accepted by parseBody (1 MiB). Every schema
 *  that flows through parseBody caps its longest field at 5,000 chars
 *  (product description) with at most a handful of URLs alongside, so a
 *  legitimate JSON body is orders of magnitude below this bound; anything
 *  larger is a client error or abuse, not a real submission. File and
 *  image uploads do NOT go through parseBody — they stream FormData or a
 *  remote-URL fetch in their own routes — so this bound never touches
 *  them. Callers that genuinely need more can pass { maxBytes }. */
export const MAX_JSON_BODY_BYTES = 1_048_576;

/** Prisma error-code helpers (Stage 3 API audit, M-1/M-5/M-8).
 *
 *  Prisma errors are identified by name + code, not class identity: the
 *  disposable SQLite harness throws the sqlite-generated client's error
 *  class, which is a different class object than the postgres one, so a
 *  bare instanceof would silently miss it (same rationale as
 *  src/lib/category-api-errors.ts). */
export function getPrismaErrorCode(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code;
  const candidate = error as { name?: unknown; code?: unknown } | null;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    candidate.name === "PrismaClientKnownRequestError" &&
    typeof candidate.code === "string"
  ) {
    return candidate.code;
  }
  return null;
}

function isPrismaKnownRequestError(error: unknown): boolean {
  return getPrismaErrorCode(error) !== null;
}

/** Transient / infrastructure Prisma failures: the database is
 *  unreachable, the pool is exhausted, or a transaction lost a write
 *  race. These are retryable by the client, so routes must answer 503
 *  (with Retry-After), never a client-error status and never the raw
 *  error text. */
const TRANSIENT_PRISMA_CODES = new Set([
  "P1001", // Can't reach database server
  "P1002", // Database server was reached but timed out
  "P1008", // Operations timed out
  "P1017", // Server has closed the connection
  "P2024", // Timed out fetching a new connection from the pool
  "P2028", // Transaction API error (timeout)
  "P2034", // Transaction failed due to a write conflict / deadlock
]);

const TRANSIENT_MESSAGE_FRAGMENTS = [
  "can't reach database server",
  "timed out fetching a new connection",
  "database is locked",
  "transaction already closed",
  "connection refused",
  "connection timed out",
  "server has closed the connection",
];

export function isTransientDbError(error: unknown): boolean {
  const code = getPrismaErrorCode(error);
  if (code !== null) return TRANSIENT_PRISMA_CODES.has(code);
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "").toLowerCase()
      : "";
  return TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment));
}

/** 503 for a transient DB/infrastructure failure, with a Retry-After so
 *  a retrying client backs off instead of treating the outage as a
 *  terminal client error. The message is generic by design: no Prisma
 *  text, no SQL, no internals ever reach the client. */
export function transientDbErrorResponse(): NextResponse {
  return jsonError("The store is busy right now — please try again in a moment.", 503, undefined, {
    headers: { "Retry-After": "5" },
  });
}

/** P2025 (record not found) → 404, mirroring the category/product
 *  mappers. Returns null when the error is anything else, so the
 *  caller's generic handling still applies. */
export function prismaNotFoundResponse(error: unknown, message: string): NextResponse | null {
  if (getPrismaErrorCode(error) === "P2025") return jsonError(message, 404);
  return null;
}

export type BoundedBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too-large" | "unreadable" };

/** Read a request body as text under the same 1 MiB cap parseBody
 *  enforces, for routes whose error contract is not parseBody's (they
 *  carry their own `code` fields, or tolerate an absent/unparseable body
 *  and must keep doing so). Callers map "too-large" to 413 and
 *  "unreadable" to their existing invalid-body path; nothing here
 *  decides a status, so no route's intentional status changes. */
export async function readBoundedBodyText(
  request: Request,
  options?: { maxBytes?: number }
): Promise<BoundedBodyResult> {
  const maxBytes = options?.maxBytes ?? MAX_JSON_BODY_BYTES;
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      return { ok: false, reason: "too-large" };
    }
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, reason: "too-large" };
  }
  return { ok: true, text };
}

/** Parse + validate a JSON body with a zod schema; returns parsed or a Response. */
export async function parseBody<T>(
  request: Request,
  schema: ZodSchema<T>,
  options?: { maxBytes?: number }
): Promise<{ data: T; error?: never } | { data?: never; error: NextResponse }> {
  const maxBytes = options?.maxBytes ?? MAX_JSON_BODY_BYTES;
  // Cheap reject before buffering: a declared Content-Length above the
  // bound can never parse into an accepted body.
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      return { error: jsonError("Request body is too large.", 413) };
    }
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { error: jsonError("Invalid request body", 400) };
  }
  // Content-Length may be absent (chunked) or lying; enforce on the
  // bytes actually received. TextEncoder measures UTF-8 bytes, not
  // UTF-16 code units, so multi-byte input cannot smuggle past the cap.
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { error: jsonError("Request body is too large.", 413) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
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

/** Wrap a route handler with uniform error handling (NFR-05). Unexpected
 * errors are captured centrally (sanitised, structured — see
 * src/lib/error-monitoring.ts) instead of being logged raw. The captured
 * context carries the proxy's x-request-id (see resolveRequestId) so one
 * id correlates the proxy log, the route log and the error line. Pass the
 * route's request when it is at hand; the headers() fallback covers the
 * call sites that do not. */
export async function handleRoute(
  fn: () => Promise<Response>,
  request?: Request,
): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MfaRequiredError) {
      return jsonError(e.message, e.status, { code: e.code });
    }
    if (e instanceof AuthError) return jsonError(e.message, e.status);
    captureError(e, { operation: "api-route", requestId: await resolveRequestId(request) });
    return jsonError("Something went wrong. Please try again.", 500);
  }
}
