import { Prisma } from "../../generated/postgres-client";
import { db } from "@/lib/db";
import { jsonError } from "@/lib/api";
import { ReservationWriteConflict } from "@/services/reservation-writes";
import { InactiveCategoryError } from "@/services/products.service";

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

/** Validate the category a product is being assigned to (admin create/update).
 *  Existence is checked first; an inactive category is rejected so the
 *  product cannot silently disappear from the storefront. */
export async function validateProductCategory(categoryId: string) {
  const category = await db.category.findUnique({
    where: { id: categoryId },
    select: { id: true, isActive: true },
  });
  if (!category) {
    return jsonError("The selected category does not exist. Please choose another category.", 422, {
      errors: { categoryId: "Please choose an existing category." },
    });
  }
  if (category.isActive === false) {
    return jsonError(
      "The selected category is inactive. Choose an active category or reactivate it first.",
      422,
      { errors: { categoryId: "This category is inactive." } },
    );
  }
  return null;
}

export function productWriteErrorResponse(error: unknown): Response | null {
  if (error instanceof ReservationWriteConflict) return jsonError(error.message, 409, { errors: { stock: error.message } });
  if (error instanceof InactiveCategoryError) {
    const message =
      "The selected category is inactive. Choose an active category or reactivate it first.";
    return jsonError(message, 422, { errors: { categoryId: message } });
  }
  if (!isPrismaKnownRequestError(error)) return null;

  if (error.code === "P2002") {
    const target = error.meta?.target;
    const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
    const normalizedTarget = fields.join(" ").toLowerCase();
    const field = normalizedTarget.includes("sku")
      ? "sku"
      : normalizedTarget.includes("slug")
        ? "slug"
        : undefined;
    const message =
      field === "sku"
        ? "This SKU is already in use. Please use a different SKU."
        : "This product slug is already in use. Please choose a different slug.";
    return jsonError(message, 409, {
      errors: field ? { [field]: message } : { _: message },
    });
  }

  if (error.code === "P2003") {
    return jsonError("The selected category no longer exists. Please choose another category.", 422, {
      errors: { categoryId: "Please choose an existing category." },
    });
  }

  if (error.code === "P2025") {
    return jsonError("Product not found.", 404);
  }

  return null;
}
