import type { User } from "../../generated/postgres-client";
import { db } from "@/lib/db";

type AuthUser = Pick<
  User,
  "id" | "email" | "passwordHash" | "name" | "image" | "role" | "emailVerified"
>;

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const users = await db.$queryRaw<AuthUser[]>`
    SELECT "id", "email", "passwordHash", "name", "image", "role", "emailVerified"
    FROM "User"
    WHERE LOWER("email") = ${normalizedEmail}
    LIMIT 1
  `;
  return users[0] ?? null;
}
