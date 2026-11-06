import { Prisma } from "../../generated/postgres-client";
import { db } from "@/lib/db";
import { jsonError } from "@/lib/api";
import { ReservationWriteConflict } from "@/services/reservation-writes";

export async function validateProductCategory(categoryId: string) {
  const category = await db.category.findUnique({
    where: { id: categoryId },
    select: { id: true },
  });
  if (category) return null;

  return jsonError("The selected category does not exist. Please choose another category.", 422, {
    errors: { categoryId: "Please choose an existing category." },
  });
}

export function productWriteErrorResponse(error: unknown): Response | null {
  if (error instanceof ReservationWriteConflict) return jsonError(error.message, 409, { errors: { stock: error.message } });
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;

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
