import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendAlertEmail: vi.fn(),
  EmailDeliveryNotConfiguredError: class EmailDeliveryNotConfiguredError extends Error {
    constructor() {
      super("Email delivery is not configured.");
      this.name = "EmailDeliveryNotConfiguredError";
    }
  },
}));

vi.mock("@/services/email.service", () => ({
  EmailDeliveryNotConfiguredError: mocks.EmailDeliveryNotConfiguredError,
  sendAlertEmail: mocks.sendAlertEmail,
}));

import {
  captureError,
  capturePaymentAlert,
  getErrorMonitoringConfig,
  resetAlertThrottle,
} from "@/lib/error-monitoring";

const ENV_KEYS = [
  "ERROR_MONITORING_ENABLED",
  "ERROR_MONITORING_ALERT_EMAIL",
  "ERROR_MONITORING_ALERT_THROTTLE_MS",
  "ERROR_MONITORING_ENVIRONMENT",
  "NODE_ENV",
] as const;

function savedEnv() {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

// process.env.NODE_ENV is typed read-only; write through a plain record.
function setEnv(key: string, value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) setEnv(key, saved[key]);
}

function parseLogLines(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map(([first]) => JSON.parse(String(first)) as Record<string, unknown>);
}

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("error monitoring config", () => {
  it("defaults to enabled, no alert email, 15-minute throttle", () => {
    const config = getErrorMonitoringConfig({
      NODE_ENV: "production",
      ERROR_MONITORING_ENABLED: undefined,
      ERROR_MONITORING_ALERT_EMAIL: undefined,
      ERROR_MONITORING_ALERT_THROTTLE_MS: undefined,
      ERROR_MONITORING_ENVIRONMENT: undefined,
    });
    expect(config).toEqual({
      enabled: true,
      environment: "production",
      alertEmailConfigured: false,
      alertThrottleMs: 900_000,
    });
  });

  it("honours explicit env values and falls back on invalid throttle", () => {
    expect(
      getErrorMonitoringConfig({
        ERROR_MONITORING_ENABLED: "false",
        ERROR_MONITORING_ALERT_EMAIL: "ops@example.invalid",
        ERROR_MONITORING_ALERT_THROTTLE_MS: "abc",
        ERROR_MONITORING_ENVIRONMENT: "staging",
      }),
    ).toMatchObject({
      enabled: false,
      alertEmailConfigured: true,
      alertThrottleMs: 900_000,
      environment: "staging",
    });
    expect(
      getErrorMonitoringConfig({ ERROR_MONITORING_ALERT_THROTTLE_MS: "60000" }).alertThrottleMs,
    ).toBe(60_000);
  });
});

describe("captureError", () => {
  let saved: Record<string, string | undefined>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    saved = savedEnv();
    delete process.env.ERROR_MONITORING_ENABLED;
    delete process.env.ERROR_MONITORING_ENVIRONMENT;
    delete process.env.ERROR_MONITORING_ALERT_EMAIL;
    resetAlertThrottle();
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv(saved);
    consoleSpy.mockRestore();
  });

  it("emits one structured JSON line with name, message and context", () => {
    captureError(new Error("database exploded"), {
      operation: "api-route",
      requestId: "req-1",
      paymentId: "pay-1",
    });
    const lines = parseLogLines(consoleSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      type: "error",
      name: "Error",
      message: "database exploded",
      operation: "api-route",
      requestId: "req-1",
      paymentId: "pay-1",
    });
    expect(typeof lines[0].timestamp).toBe("string");
    expect(lines[0].stack).toBeUndefined();
  });

  it("includes the stack in development only", () => {
    setEnv("NODE_ENV", "development");
    captureError(new Error("dev boom"));
    expect(parseLogLines(consoleSpy)[0].stack).toContain("dev boom");

    consoleSpy.mockClear();
    setEnv("NODE_ENV", "production");
    captureError(new Error("prod boom"));
    expect(parseLogLines(consoleSpy)[0].stack).toBeUndefined();
  });

  it("redacts secrets from messages and never leaks credential URLs", () => {
    captureError(
      new Error(
        "call failed: api_key=sk-abc123def456 password: hunter2 Bearer abc.def.ghi " +
          "connect postgresql://admin:s3cret@db.example.com:5432/db",
      ),
    );
    const line = JSON.stringify(parseLogLines(consoleSpy)[0]);
    expect(line).not.toContain("sk-abc123def456");
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("abc.def.ghi");
    expect(line).not.toContain("s3cret");
    expect(line).toContain("[REDACTED]");
  });

  it("caps long messages and drops non-allowlisted context", () => {
    captureError(new Error("x".repeat(2_000)), {
      operation: "api-route",
      // @ts-expect-error deliberately passing forbidden context fields
      customerEmail: "buyer@example.invalid",
      cardNumber: "4111111111111111",
    });
    const line = parseLogLines(consoleSpy)[0];
    expect(String(line.message).length).toBeLessThanOrEqual(501);
    expect(JSON.stringify(line)).not.toContain("buyer@example.invalid");
    expect(JSON.stringify(line)).not.toContain("4111111111111111");
  });

  it("is a no-op when monitoring is disabled", () => {
    process.env.ERROR_MONITORING_ENABLED = "false";
    captureError(new Error("should not appear"));
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("never throws, even for non-errors and hostile values", () => {
    expect(() => captureError(null)).not.toThrow();
    expect(() => captureError(undefined)).not.toThrow();
    expect(() => captureError("plain string")).not.toThrow();
    expect(() => captureError({ toJSON: () => { throw new Error("hostile"); } })).not.toThrow();
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "message", {
      get() { throw new Error("getter boom"); },
    });
    expect(() => captureError(hostile)).not.toThrow();
    // Something was still emitted (the monitoring-failure fallback line).
    expect(consoleSpy).toHaveBeenCalled();
  });
});

describe("capturePaymentAlert", () => {
  let saved: Record<string, string | undefined>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    saved = savedEnv();
    delete process.env.ERROR_MONITORING_ENABLED;
    delete process.env.ERROR_MONITORING_ENVIRONMENT;
    process.env.ERROR_MONITORING_ALERT_EMAIL = "ops@example.invalid";
    process.env.ERROR_MONITORING_ALERT_THROTTLE_MS = "60000";
    resetAlertThrottle();
    vi.clearAllMocks();
    mocks.sendAlertEmail.mockResolvedValue(undefined);
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv(saved);
    consoleSpy.mockRestore();
  });

  it("logs the alert and emails it once per kind+code within the throttle window", async () => {
    capturePaymentAlert("WEBHOOK_FAILURE", { operation: "webhook-receive", code: "QUARANTINED", eventId: "evt-1" });
    capturePaymentAlert("WEBHOOK_FAILURE", { operation: "webhook-receive", code: "QUARANTINED", eventId: "evt-2" });
    await flushAsync();

    const lines = parseLogLines(consoleSpy);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      type: "payment-alert",
      kind: "WEBHOOK_FAILURE",
      code: "QUARANTINED",
      eventId: "evt-1",
    });
    expect(mocks.sendAlertEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ops@example.invalid",
        subject: "[Khareedo alert] WEBHOOK_FAILURE — QUARANTINED",
      }),
    );
    const body = String(mocks.sendAlertEmail.mock.calls[0][0].text);
    expect(body).toContain("evt-1");
    expect(body).not.toContain("evt-2");

    resetAlertThrottle();
    capturePaymentAlert("WEBHOOK_FAILURE", { operation: "webhook-receive", code: "QUARANTINED", eventId: "evt-3" });
    await flushAsync();
    expect(mocks.sendAlertEmail).toHaveBeenCalledTimes(2);
  });

  it("alerts a different code separately and skips email when no recipient is configured", async () => {
    capturePaymentAlert("WORKER_FAILURE", { code: "SWEEP_FAILED" });
    capturePaymentAlert("PAYMENT_FAILURE", { code: "REFUND_SUBMISSION_FAILED" });
    await flushAsync();
    expect(mocks.sendAlertEmail).toHaveBeenCalledTimes(2);

    delete process.env.ERROR_MONITORING_ALERT_EMAIL;
    mocks.sendAlertEmail.mockClear();
    capturePaymentAlert("WORKER_FAILURE", { code: "SWEEP_FAILED" });
    await flushAsync();
    // The structured log line is still emitted; only the email is skipped.
    expect(parseLogLines(consoleSpy).some((l) => l.kind === "WORKER_FAILURE")).toBe(true);
    expect(mocks.sendAlertEmail).not.toHaveBeenCalled();
  });

  it("never throws when the mail host is down, and stays silent when SMTP is unconfigured", async () => {
    mocks.sendAlertEmail.mockRejectedValueOnce(new Error("SMTP connection refused"));
    expect(() =>
      capturePaymentAlert("WORKER_FAILURE", { code: "SWEEP_FAILED" }),
    ).not.toThrow();
    await flushAsync();
    expect(parseLogLines(consoleSpy).some((l) => l.type === "payment-alert-delivery-failed")).toBe(true);

    consoleSpy.mockClear();
    mocks.sendAlertEmail.mockRejectedValueOnce(new mocks.EmailDeliveryNotConfiguredError());
    resetAlertThrottle();
    expect(() =>
      capturePaymentAlert("WORKER_FAILURE", { code: "SWEEP_FAILED" }),
    ).not.toThrow();
    await flushAsync();
    expect(parseLogLines(consoleSpy).some((l) => l.type === "payment-alert-delivery-failed")).toBe(false);
  });

  it("is a no-op when monitoring is disabled", async () => {
    process.env.ERROR_MONITORING_ENABLED = "false";
    capturePaymentAlert("WORKER_FAILURE", { code: "SWEEP_FAILED" });
    await flushAsync();
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(mocks.sendAlertEmail).not.toHaveBeenCalled();
  });
});
