import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());

if (process.env.SAFEPAY_ENVIRONMENT !== "sandbox") {
  throw new Error("This test is sandbox-only.");
}

const secret = process.env.SAFEPAY_WEBHOOK_SECRET;
if (!secret) {
  throw new Error("Local webhook secret is not configured.");
}

const original = JSON.stringify({
  type: "payment.succeeded",
  token: `tamper-test-${randomUUID()}`,
  data: {
    tracker: "NONEXISTENT_TAMPER_TEST_TRACKER",
    state: "TRACKER_ENDED",
    amount: 799900,
    currency: "PKR",
    note: "original"
  }
});

const signature = createHmac("sha512", secret)
  .update(original)
  .digest("hex");

// Modify the body AFTER creating the signature.
const modified = original.replace(
  '"note":"original"',
  '"note":"tampered"'
);

if (modified === original) {
  throw new Error("Body modification failed.");
}

const response = await fetch(
  "http://localhost:3000/api/webhooks/safepay",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SFPY-SIGNATURE": signature
    },
    body: modified
  }
);

const result = await response.json();

console.log("HTTP Status:", response.status);
console.log("Webhook Result:", result.code);

if (response.status !== 200 || result.code !== "quarantined") {
  throw new Error("Unexpected webhook quarantine result.");
}

console.log("PASS: Tampered webhook quarantined.");
