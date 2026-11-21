// Category write error mapping (Phase 3, Chunk 5) — mirrors
// src/lib/product-api-errors.ts so admin category failures surface as
// clear user-facing errors instead of unhandled 500s.
import { Prisma } from "../../generated/postgres-client";
import { jsonError } from "@/lib/api";
import { CategoryValidationError } from "@/services/categories.service";

/** Prisma errors are identified by name + code, not class identity: the
 *  disposable SQLite harness throws the sqlite-generated client's error
 *  class, which is a different class object than the postgres one, so a
 *  bare instanceof would silently miss it and the route would 500. */
function isPrismaKnownRequestError(
  error: unknown,
): error is { code: string; meta?: { target?: unknown } } {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return true;
  const candidate = error as { name?: unknown; code?: unknown } | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    candidate.name === "PrismaClientKnownRequestError" &&
    typeof candidate.code === "string"
  );
}

export function categoryWriteErrorResponse(error: unknown): Response | null {
  if (error instanceof CategoryValidationError) {
    return jsonError(error.message, 422, { errors: { [error.field]: error.message } });
  }
  if (!isPrismaKnownRequestError(error)) return null;

  if (error.code === "P2002") {
    const message = "This category slug is already in use. Please choose a different slug.";
    return jsonError(message, 409, { errors: { slug: message } });
  }

  if (error.code === "P2003") {
    return jsonError("The selected parent category does not exist. Please choose another parent.", 422, {
      errors: { parentId: "Please choose an existing parent category." },
    });
  }

  if (error.code === "P2025") {
    return jsonError("Category not found.", 404);
  }

  return null;
}
