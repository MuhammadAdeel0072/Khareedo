import nodemailer from "nodemailer";

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
}) {
  const config = smtpConfiguration();
  const siteUrl = process.env.NEXTAUTH_URL;
  if (!siteUrl) throw new EmailDeliveryNotConfiguredError();

  const verificationUrl = new URL("/verify-email", siteUrl);
  verificationUrl.searchParams.set("token", input.token);
  const greeting = input.name ? `Hello ${escapeHtml(input.name)},` : "Hello,";
  const link = escapeHtml(verificationUrl.toString());

  const transporter = getTransporter(config);
  await transporter.sendMail({
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
