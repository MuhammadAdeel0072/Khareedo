import nodemailer from "nodemailer";
import { safeCallbackUrl } from "@/lib/auth-client";

// One transporter per process: connection pooling + no per-email setup cost.
let cachedTransporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter(config: {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}) {
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.auth,
      // Bound every phase of the SMTP conversation so a slow/broken SMTP host
      // cannot stall registration for the platform's default (minutes-long) timeout.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return cachedTransporter;
}

/**
 * Drop the cached transporter so the next send builds a fresh one from the
 * current environment. Used after a permanent SMTP auth failure: a bad
 * first config (wrong password, rotated credential) must not stay cached
 * forever — without this, fixing SMTP_USER/SMTP_PASSWORD in the environment
 * would have no effect until the process restarted. Timeouts are unchanged
 * (10s connect/greeting, 20s socket) because they are set at creation.
 */
export function resetEmailTransporter(): void {
  cachedTransporter = null;
}

export type EmailSendFailureKind = "permanent" | "transient";

export type EmailSendFailureClassification = {
  kind: EmailSendFailureKind;
  /** True when retrying the same send cannot succeed. */
  permanent: boolean;
  /** True for an SMTP auth failure — the cached transporter must be dropped. */
  authFailure: boolean;
  /** Short operator-facing reason, safe to store in an outbox row's lastError. */
  reason: string;
};

/**
 * Classify a failed sendMail so the outbox worker can tell a futile retry
 * from a transient outage (unit-testable; see email-send-classifier.test.ts).
 *
 * Permanent (fail immediately, no retries):
 * - EmailDeliveryNotConfiguredError — SMTP is not configured at all.
 * - SMTP auth failure — nodemailer code EAUTH, or a 535/534 response, or an
 *   "authentication failed / invalid login" message. Retrying the same
 *   credentials cannot succeed; the operator must fix SMTP_USER/SMTP_PASSWORD.
 * - A half-configured SMTP_USER/SMTP_PASSWORD pair (one set, the other not).
 * - Invalid recipient — nodemailer code EENVELOPE, a 5xx SMTP response
 *   (550 mailbox unavailable, 551, 553 relay denied, 501 syntax error), or
 *   a "mailbox unavailable / user unknown / recipient rejected" message.
 *   A 5xx response is a permanent SMTP rejection by definition (RFC 5321);
 *   a 4xx response is transient and retried.
 *
 * Transient (exponential backoff, up to MAX_ATTEMPTS):
 * - Timeouts, connection refused/reset, DNS failures, socket errors, and
 *   any error that matches none of the permanent patterns above. Unknown
 *   errors default to transient: retrying a send that might succeed is
 *   safer than dropping a customer's email on an unrecognised message.
 */
export function classifyEmailSendError(error: unknown): EmailSendFailureClassification {
  if (error instanceof EmailDeliveryNotConfiguredError) {
    return {
      kind: "permanent",
      permanent: true,
      authFailure: false,
      reason: "Email delivery is not configured (SMTP_HOST/SMTP_PORT/SMTP_FROM/NEXTAUTH_URL missing).",
    };
  }
  const err = error as {
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
    name?: unknown;
  } | null;
  const code = typeof err?.code === "string" ? err.code : "";
  const responseCode =
    typeof err?.responseCode === "number"
      ? err.responseCode
      : typeof err?.responseCode === "string" && /^\d+$/.test(err.responseCode)
        ? Number(err.responseCode)
        : null;
  const message = typeof err?.message === "string" ? err.message : "";

  if (
    code === "EAUTH" ||
    responseCode === 535 ||
    responseCode === 534 ||
    /authentication failed|invalid login|username and password not accepted|535/i.test(message)
  ) {
    return {
      kind: "permanent",
      permanent: true,
      authFailure: true,
      reason: "SMTP authentication failed — check SMTP_USER/SMTP_PASSWORD.",
    };
  }
  if (/SMTP_USER and SMTP_PASSWORD must both be configured/.test(message)) {
    return {
      kind: "permanent",
      permanent: true,
      authFailure: false,
      reason: "SMTP_USER and SMTP_PASSWORD must both be configured.",
    };
  }
  if (
    code === "EENVELOPE" ||
    (responseCode !== null && responseCode >= 500 && responseCode < 600) ||
    /mailbox unavailable|user unknown|no such user|recipient address rejected|invalid recipient|550/i.test(message)
  ) {
    return {
      kind: "permanent",
      permanent: true,
      authFailure: false,
      reason: "Invalid recipient — the SMTP server permanently rejected the address.",
    };
  }
  return {
    kind: "transient",
    permanent: false,
    authFailure: false,
    reason: "Transient email delivery failure — will retry with backoff.",
  };
}

/**
 * Send one message through the cached transporter. On a permanent SMTP
 * auth failure the cached transporter is dropped before rethrowing, so a
 * corrected SMTP_USER/SMTP_PASSWORD takes effect on the next send without
 * a process restart. The error is rethrown unchanged — the caller
 * (the outbox worker) classifies it via classifyEmailSendError.
 */
async function sendMailViaTransporter(
  config: Parameters<typeof getTransporter>[0],
  mail: Parameters<ReturnType<typeof nodemailer.createTransport>["sendMail"]>[0]
): Promise<void> {
  const transporter = getTransporter(config);
  try {
    await transporter.sendMail(mail);
  } catch (error) {
    if (classifyEmailSendError(error).authFailure) {
      resetEmailTransporter();
    }
    throw error;
  }
}

export class EmailDeliveryNotConfiguredError extends Error {
  constructor() {
    super("Email delivery is not configured.");
    this.name = "EmailDeliveryNotConfiguredError";
  }
}

function smtpConfiguration() {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT);
  const from = process.env.SMTP_FROM?.trim();
  const siteUrl = process.env.NEXTAUTH_URL;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !from || !siteUrl) {
    throw new EmailDeliveryNotConfiguredError();
  }
  if (Boolean(user) !== Boolean(password)) {
    throw new Error("SMTP_USER and SMTP_PASSWORD must both be configured.");
  }

  new URL(siteUrl);
  return {
    host,
    port,
    secure: process.env.SMTP_SECURE === "true",
    from,
    auth: user && password ? { user, pass: password } : undefined,
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

export async function sendVerificationEmail(input: {
  email: string;
  name: string | null;
  token: string;
  callbackUrl?: string;
}) {
  const config = smtpConfiguration();
  const siteUrl = process.env.NEXTAUTH_URL;
  if (!siteUrl) throw new EmailDeliveryNotConfiguredError();

  const verificationUrl = new URL("/verify-email", siteUrl);
  verificationUrl.searchParams.set("token", input.token);
  verificationUrl.searchParams.set("callbackUrl", safeCallbackUrl(input.callbackUrl));
  const greeting = input.name ? `Hello ${escapeHtml(input.name)},` : "Hello,";
  const link = escapeHtml(verificationUrl.toString());

  await sendMailViaTransporter(config, {
    from: config.from,
    to: input.email,
    subject: "Verify your Khareedo email address",
    text: `${input.name ? `Hello ${input.name},\n\n` : "Hello,\n\n"}Verify your email address by opening this link: ${verificationUrl.toString()}\n\nThis link expires in 24 hours. If you did not create a Khareedo account, you can ignore this email.`,
    html: `<p>${greeting}</p><p>Verify your Khareedo email address:</p><p><a href="${link}">Verify email address</a></p><p>This link expires in 24 hours. If you did not create a Khareedo account, you can ignore this email.</p>`,
  });
}

export function isEmailDeliveryConfigured() {
  try {
    smtpConfiguration();
    return true;
  } catch (error) {
    if (error instanceof EmailDeliveryNotConfiguredError) return false;
    throw error;
  }
}

/** Send a password reset email (PR-09). Mirrors sendVerificationEmail: the
 * reset link carries the raw token once; only its SHA-256 hash is stored.
 * The link expires in 1 hour. Throws EmailDeliveryNotConfiguredError when
 * SMTP is not configured. */
export async function sendPasswordResetEmail(input: {
  email: string;
  name: string | null;
  token: string;
}) {
  const config = smtpConfiguration();
  const siteUrl = process.env.NEXTAUTH_URL;
  if (!siteUrl) throw new EmailDeliveryNotConfiguredError();

  const resetUrl = new URL("/reset-password", siteUrl);
  resetUrl.searchParams.set("token", input.token);
  const greeting = input.name ? `Hello ${escapeHtml(input.name)},` : "Hello,";
  const link = escapeHtml(resetUrl.toString());

  await sendMailViaTransporter(config, {
    from: config.from,
    to: input.email,
    subject: "Reset your Khareedo password",
    text: `${input.name ? `Hello ${input.name},\n\n` : "Hello,\n\n"}Reset your Khareedo password by opening this link: ${resetUrl.toString()}\n\nThis link expires in 1 hour and can only be used once. If you did not request a password reset, you can ignore this email — your password will not change.`,
    html: `<p>${greeting}</p><p>Reset your Khareedo password:</p><p><a href="${link}">Reset password</a></p><p>This link expires in 1 hour and can only be used once. If you did not request a password reset, you can ignore this email — your password will not change.</p>`,
  });
}

/** Send an operator alert email (error monitoring). Reuses the same SMTP
 * configuration and pooled transporter as verification mail. The caller is
 * responsible for keeping the subject/body free of customer data, payment
 * credentials and payloads — identifiers and codes only. Throws
 * EmailDeliveryNotConfiguredError when SMTP is not configured. */
export async function sendAlertEmail(input: {
  to: string;
  subject: string;
  text: string;
}) {
  const config = smtpConfiguration();
  const to = input.to.trim();
  if (!to || to.includes("\n") || to.includes("\r") || !to.includes("@")) {
    throw new Error("Alert email recipient is invalid.");
  }
  const subject = input.subject.replace(/[\r\n]/g, " ").trim();
  if (!subject) throw new Error("Alert email subject is required.");
  await sendMailViaTransporter(config, {
    from: config.from,
    to,
    subject,
    text: input.text,
  });
}

// --- Order notifications (Phase 3, Chunk 7-final — D14/H-14) --------------
//
// Simple professional Khareedo branding, following the same shape as the
// verification/reset sends above: plain-text + HTML, escaped customer data,
// one link to the customer's order page. These functions only SEND —
// enqueueing, dedup and retries live in email-outbox.service.ts, and the
// decision of *when* to send lives in order-notification.service.ts.
// Amounts are integer rupees (Order.total); refund amounts arrive in minor
// units and are converted here.

export type OrderEmailInput = {
  email: string;
  name: string | null;
  reference: string;
  orderId: string;
  total: number;
  paymentMethod: string;
};

function orderUrl(orderId: string) {
  const siteUrl = process.env.NEXTAUTH_URL;
  if (!siteUrl) throw new EmailDeliveryNotConfiguredError();
  return new URL(`/account/orders/${orderId}`, siteUrl).toString();
}

function orderEmailShell(input: {
  email: string;
  name: string | null;
  subject: string;
  intro: string;
  lines: string[];
  linkLabel: string;
  link: string;
}) {
  const config = smtpConfiguration();
  const greeting = input.name ? `Hello ${escapeHtml(input.name)},` : "Hello,";
  const link = escapeHtml(input.link);
  const bodyLines = input.lines.map((line) => escapeHtml(line)).join("</p><p>");
  return {
    config,
    greeting,
    mail: {
      from: config.from,
      to: input.email,
      subject: input.subject,
      text:
        `${input.name ? `Hello ${input.name},\n\n` : "Hello,\n\n"}` +
        `${input.intro}\n\n${input.lines.join("\n")}\n\n${input.linkLabel}: ${input.link}\n`,
      html:
        `<p>${greeting}</p><p>${escapeHtml(input.intro)}</p><p>${bodyLines}</p>` +
        `<p><a href="${link}">${escapeHtml(input.linkLabel)}</a></p>`,
    },
  };
}

export async function sendOrderConfirmedEmail(input: OrderEmailInput) {
  const { config, mail } = orderEmailShell({
    ...input,
    subject: `Your Khareedo order ${input.reference} is confirmed`,
    intro: "Thank you for shopping with Khareedo. Your order is confirmed.",
    lines: [
      `Order: ${input.reference}`,
      `Total: Rs ${input.total.toLocaleString("en-PK")}`,
      input.paymentMethod === "COD"
        ? "Payment: Cash on Delivery — you'll pay when your order arrives."
        : "Payment: Online — your payment has been received.",
    ],
    linkLabel: "View your order",
    link: orderUrl(input.orderId),
  });
  await sendMailViaTransporter(config, mail);
}

const ORDER_STATUS_PHRASES: Record<string, string> = {
  CONFIRMED: "is confirmed",
  PROCESSING: "is being prepared",
  SHIPPED: "has shipped",
  DELIVERED: "has been delivered",
};

export async function sendOrderStatusEmail(
  input: OrderEmailInput & { status: string; carrier?: string | null; trackingNumber?: string | null }
) {
  const phrase = ORDER_STATUS_PHRASES[input.status] ?? `is now ${input.status.toLowerCase()}`;
  const lines = [
    `Order: ${input.reference}`,
    `Total: Rs ${input.total.toLocaleString("en-PK")}`,
    ...(input.status === "SHIPPED" && input.carrier ? [`Carrier: ${input.carrier}`] : []),
    ...(input.status === "SHIPPED" && input.trackingNumber ? [`Tracking number: ${input.trackingNumber}`] : []),
  ];
  const { config, mail } = orderEmailShell({
    ...input,
    subject: `Your Khareedo order ${input.reference} ${phrase}`,
    intro: `Your order ${input.reference} ${phrase}.`,
    lines,
    linkLabel: "Track your order",
    link: orderUrl(input.orderId),
  });
  await sendMailViaTransporter(config, mail);
}

export async function sendOrderCancelledEmail(input: OrderEmailInput) {
  const { config, mail } = orderEmailShell({
    ...input,
    subject: `Your Khareedo order ${input.reference} was cancelled`,
    intro: "Your order has been cancelled. No further action is needed.",
    lines: [
      `Order: ${input.reference}`,
      `Total: Rs ${input.total.toLocaleString("en-PK")}`,
      "If you paid online, any refund will be handled separately and confirmed by email.",
    ],
    linkLabel: "View your order",
    link: orderUrl(input.orderId),
  });
  await sendMailViaTransporter(config, mail);
}

export async function sendOrderPaymentSucceededEmail(input: OrderEmailInput) {
  const { config, mail } = orderEmailShell({
    ...input,
    subject: `Payment received for your Khareedo order ${input.reference}`,
    intro: "We've received your payment. Your order is confirmed and being prepared.",
    lines: [
      `Order: ${input.reference}`,
      `Amount paid: Rs ${input.total.toLocaleString("en-PK")}`,
    ],
    linkLabel: "View your order",
    link: orderUrl(input.orderId),
  });
  await sendMailViaTransporter(config, mail);
}

export async function sendOrderPaymentFailedEmail(input: OrderEmailInput) {
  const { config, mail } = orderEmailShell({
    ...input,
    subject: `Payment failed for your Khareedo order ${input.reference}`,
    intro:
      "Your payment could not be completed, so your order was not confirmed. " +
      "You can place the order again from your cart.",
    lines: [
      `Order: ${input.reference}`,
      `Amount: Rs ${input.total.toLocaleString("en-PK")}`,
      "If you notice a charge for this order, please contact us and we'll look into it.",
    ],
    linkLabel: "View your order",
    link: orderUrl(input.orderId),
  });
  await sendMailViaTransporter(config, mail);
}

export async function sendOrderRefundSucceededEmail(
  input: OrderEmailInput & { refundAmountMinor: bigint | number }
) {
  const refundAmount =
    typeof input.refundAmountMinor === "bigint"
      ? Number(input.refundAmountMinor) / 100
      : input.refundAmountMinor / 100;
  const { config, mail } = orderEmailShell({
    ...input,
    subject: `Refund processed for your Khareedo order ${input.reference}`,
    intro: "Your refund has been processed.",
    lines: [
      `Order: ${input.reference}`,
      `Refund amount: Rs ${refundAmount.toLocaleString("en-PK")}`,
      "The refunded amount should reach your original payment method within a few working days, depending on your bank.",
    ],
    linkLabel: "View your order",
    link: orderUrl(input.orderId),
  });
  await sendMailViaTransporter(config, mail);
}
