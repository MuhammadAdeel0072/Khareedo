-- Administrator TOTP MFA (PR-10).
-- Additive only: no existing rows are modified. One AdminMfa row per admin,
-- created at enrollment; recovery codes are stored as SHA-256 hashes only.
-- The TOTP secret is stored AES-256-GCM encrypted (IV + auth tag +
-- ciphertext, concatenated); only the ciphertext is persisted, never the
-- plaintext secret.

BEGIN;

CREATE TABLE "AdminMfa" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "secretEncrypted" BYTEA NOT NULL,
  "pendingSecretEncrypted" BYTEA,
  "enabledAt" TIMESTAMP(3),
  "lastVerifiedAt" TIMESTAMP(3),
  "lastUsedStep" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminMfa_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminMfa_userId_key" ON "AdminMfa"("userId");

CREATE TABLE "AdminMfaRecoveryCode" (
  "id" TEXT NOT NULL,
  "mfaId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminMfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminMfaRecoveryCode_codeHash_key" ON "AdminMfaRecoveryCode"("codeHash");
CREATE INDEX "AdminMfaRecoveryCode_mfaId_idx" ON "AdminMfaRecoveryCode"("mfaId");

ALTER TABLE "AdminMfa" ADD CONSTRAINT "AdminMfa_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdminMfaRecoveryCode" ADD CONSTRAINT "AdminMfaRecoveryCode_mfaId_fkey"
  FOREIGN KEY ("mfaId") REFERENCES "AdminMfa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Match existing server-only access policy; no browser/anonymous/authenticated table grants.
REVOKE ALL PRIVILEGES ON TABLE public."AdminMfa"
FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."AdminMfaRecoveryCode"
FROM PUBLIC, anon, authenticated;

-- Block direct row access unless explicitly authorized.
ALTER TABLE public."AdminMfa"
ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AdminMfaRecoveryCode"
ENABLE ROW LEVEL SECURITY;

COMMIT;
