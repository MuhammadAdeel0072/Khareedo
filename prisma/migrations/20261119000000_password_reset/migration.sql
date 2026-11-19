-- Password reset tokens and password-changed timestamp (PR-09).
-- Additive only: no existing rows are modified. passwordChangedAt is
-- nullable and defaults to NULL (no password change recorded yet).
-- PasswordResetToken mirrors VerificationToken: only the SHA-256 hash of the
-- token is stored; the raw token is emailed once and never persisted.
-- Tokens are single-use (consumedAt) and expiring (expiresAt).

BEGIN;

CREATE TABLE "PasswordResetToken" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);

-- Match existing server-only access policy; no browser/anonymous/authenticated table grants.
-- Keep password reset tokens private.
REVOKE ALL PRIVILEGES ON TABLE public."PasswordResetToken"
FROM PUBLIC, anon, authenticated;

-- Block direct row access unless explicitly authorized.
ALTER TABLE public."PasswordResetToken"
ENABLE ROW LEVEL SECURITY;

COMMIT;
