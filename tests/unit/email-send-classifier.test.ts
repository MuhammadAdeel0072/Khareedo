// Unit tests — email send failure classification + transporter reset
// (email-outbox reliability stream). classifyEmailSendError is pure and is
// tested here against the REAL email.service module (nodemailer mocked, no
// real SMTP, no real email sent). The outbox worker relies on it to decide
// whether a failed send is worth retrying: permanent failures go FAILED on
// the first attempt, transient ones retry with backoff.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockSendMail = vi.fn();
  const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));
  return { mockSendMail, mockCreateTransport };
});
const { mockSendMail, mockCreateTransport } = mocks;
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.mockCreateTransport } }));

import {
  EmailDeliveryNotConfiguredError,
  classifyEmailSendError,
  resetEmailTransporter,
  sendPasswordResetEmail,
} from "@/services/email.service";

function errorWith(fields: Record<string, unknown>, message: string): Error {
  const error = new Error(message);
  Object.assign(error, fields);
  return error;
}

describe("classifyEmailSendError", () => {
  it("classifies a missing SMTP configuration as permanent (never retry)", () => {
    const result = classifyEmailSendError(new EmailDeliveryNotConfiguredError());
    expect(result.kind).toBe("permanent");
    expect(result.permanent).toBe(true);
    expect(result.authFailure).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it.each([
    ["EAUTH code", errorWith({ code: "EAUTH" }, "Invalid login")],
    ["535 response code", errorWith({ responseCode: 535 }, "5.7.8 Username and Password not accepted")],
    ["534 response code", errorWith({ responseCode: 534 }, "5.7.9 Authentication mechanism is too weak")],
    ["535 in the message", new Error("535 5.7.8 Authentication Credentials Invalid")],
    ["authentication failed message", new Error("SMTP authentication failed")],
  ])("classifies %s as a permanent auth failure", (_label, error) => {
    const result = classifyEmailSendError(error);
    expect(result.kind).toBe("permanent");
    expect(result.permanent).toBe(true);
    expect(result.authFailure).toBe(true);
    expect(result.reason).toMatch(/authentication failed/i);
  });

  it("classifies a half-configured SMTP_USER/SMTP_PASSWORD pair as permanent", () => {
    const result = classifyEmailSendError(
      new Error("SMTP_USER and SMTP_PASSWORD must both be configured.")
    );
    expect(result.permanent).toBe(true);
    expect(result.authFailure).toBe(false);
  });

  it.each([
    ["EENVELOPE code", errorWith({ code: "EENVELOPE" }, "Invalid recipient")],
    ["550 response code", errorWith({ responseCode: 550 }, "5.1.1 Mailbox unavailable")],
    ["551 response code", errorWith({ responseCode: 551 }, "5.1.2 User not local")],
    ["553 response code", errorWith({ responseCode: 553 }, "5.7.1 Relaying denied")],
    ["501 response code", errorWith({ responseCode: 501 }, "5.5.2 Syntax error")],
    ["550 as a string response code", errorWith({ responseCode: "550" }, "Mailbox unavailable")],
    ["mailbox unavailable message", new Error("550 5.1.1 The email account does not exist")],
    ["user unknown message", new Error("Recipient address rejected: User unknown")],
  ])("classifies %s as a permanent invalid-recipient failure", (_label, error) => {
    const result = classifyEmailSendError(error);
    expect(result.kind).toBe("permanent");
    expect(result.permanent).toBe(true);
    expect(result.authFailure).toBe(false);
    expect(result.reason).toMatch(/recipient/i);
  });

  it.each([
    ["421 (service not available)", errorWith({ responseCode: 421 }, "4.7.0 Service not available")],
    ["451 (local error)", errorWith({ responseCode: 451 }, "4.3.0 Local error in processing")],
    ["ETIMEDOUT", errorWith({ code: "ETIMEDOUT" }, "Connection timed out")],
    ["ECONNREFUSED", errorWith({ code: "ECONNREFUSED" }, "SMTP connection refused")],
    ["ECONNRESET", errorWith({ code: "ECONNRESET" }, "Connection reset by peer")],
    ["ESOCKET", errorWith({ code: "ESOCKET" }, "Socket closed")],
    ["EAI_AGAIN (DNS)", errorWith({ code: "EAI_AGAIN" }, "getaddrinfo EAI_AGAIN smtp.example.invalid")],
    ["plain generic error", new Error("SMTP connection refused")],
  ])("classifies %s as transient (retry with backoff)", (_label, error) => {
    const result = classifyEmailSendError(error);
    expect(result.kind).toBe("transient");
    expect(result.permanent).toBe(false);
    expect(result.authFailure).toBe(false);
  });

  it("defaults unknown and non-Error values to transient — a send that might succeed must not be dropped", () => {
    expect(classifyEmailSendError("weird string error").kind).toBe("transient");
    expect(classifyEmailSendError(null).kind).toBe("transient");
    expect(classifyEmailSendError(undefined).kind).toBe("transient");
    expect(classifyEmailSendError({}).kind).toBe("transient");
  });
});

describe("cached transporter reset", () => {
  const previousEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_FROM", "SMTP_USER", "SMTP_PASSWORD", "NEXTAUTH_URL"]) {
      previousEnv[key] = process.env[key];
    }
    process.env.SMTP_HOST = "smtp.example.invalid";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_FROM = "Khareedo <no-reply@khareedo.test>";
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEmailTransporter();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue(undefined);
    resetEmailTransporter();
  });

  it("caches one transporter per process, and resetEmailTransporter() forces a fresh one", async () => {
    await sendPasswordResetEmail({ email: "a@example.invalid", name: null, token: "tok-1" });
    await sendPasswordResetEmail({ email: "b@example.invalid", name: null, token: "tok-2" });
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledTimes(2);

    resetEmailTransporter();
    await sendPasswordResetEmail({ email: "c@example.invalid", name: null, token: "tok-3" });
    expect(mockCreateTransport).toHaveBeenCalledTimes(2);
  });

  it("drops the cached transporter after an SMTP auth failure, so corrected credentials take effect without a restart", async () => {
    await sendPasswordResetEmail({ email: "a@example.invalid", name: null, token: "tok-1" });
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);

    mockSendMail.mockRejectedValueOnce(errorWith({ code: "EAUTH" }, "535 5.7.8 Authentication Credentials Invalid"));
    await expect(
      sendPasswordResetEmail({ email: "a@example.invalid", name: null, token: "tok-2" })
    ).rejects.toThrow("535");

    // The next send builds a fresh transporter from the current env.
    mockSendMail.mockResolvedValue(undefined);
    await sendPasswordResetEmail({ email: "a@example.invalid", name: null, token: "tok-3" });
    expect(mockCreateTransport).toHaveBeenCalledTimes(2);
    expect(mockSendMail).toHaveBeenCalledTimes(3);
  });

  it("keeps the cached transporter after a transient failure", async () => {
    await sendPasswordResetEmail({ email: "a@example.invalid", name: null, token: "tok-1" });
    mockSendMail.mockRejectedValueOnce(new Error("SMTP connection refused"));
    await expect(
      sendPasswordResetEmail({ email: "a@example.invalid", name: null, token: "tok-2" })
    ).rejects.toThrow("SMTP connection refused");

    mockSendMail.mockResolvedValue(undefined);
    await sendPasswordResetEmail({ email: "a@example.invalid", name: null, token: "tok-3" });
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
  });

  it("keeps the 10s/10s/20s timeouts on the created transporter", async () => {
    await sendPasswordResetEmail({ email: "a@example.invalid", name: null, token: "tok-1" });
    const options = (mockCreateTransport.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(options.connectionTimeout).toBe(10_000);
    expect(options.greetingTimeout).toBe(10_000);
    expect(options.socketTimeout).toBe(20_000);
  });
});
