// Instrumentation worker-startup tests (PR-09).
//
// The Next.js instrumentation hook starts two independent in-process
// workers: the payment maintenance worker and the email outbox worker.
// Each has its OWN opt-out env var, and disabling one must never silently
// disable the other. Regression: the hook used to `return` early when
// PAYMENT_MAINTENANCE_WORKER=off, which also prevented the email outbox
// worker from starting — so disabling payment maintenance silently
// disabled password-reset email delivery.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRegisterProcessErrorMonitor,
  mockStartPaymentMaintenanceWorker,
  mockStartEmailOutboxWorker,
  mockCaptureError,
} = vi.hoisted(() => ({
  mockRegisterProcessErrorMonitor: vi.fn(),
  mockStartPaymentMaintenanceWorker: vi.fn(),
  mockStartEmailOutboxWorker: vi.fn(),
  mockCaptureError: vi.fn(),
}));

vi.mock("@/instrumentation-node", () => ({
  registerProcessErrorMonitor: mockRegisterProcessErrorMonitor,
}));
vi.mock("@/services/payment-maintenance-worker.service", () => ({
  startPaymentMaintenanceWorker: mockStartPaymentMaintenanceWorker,
}));
vi.mock("@/services/email-outbox.service", () => ({
  startEmailOutboxWorker: mockStartEmailOutboxWorker,
}));
vi.mock("@/lib/error-monitoring", () => ({
  captureError: mockCaptureError,
}));

import { register } from "@/instrumentation";

const envKeys = ["NEXT_RUNTIME", "NEXT_PHASE", "PAYMENT_MAINTENANCE_WORKER", "EMAIL_OUTBOX_WORKER"] as const;
type EnvKey = (typeof envKeys)[number];

function setNodeRuntime() {
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.NEXT_PHASE;
}

describe("instrumentation worker startup", () => {
  const savedEnv = new Map<EnvKey, string | undefined>();

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of envKeys) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    setNodeRuntime();
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("starts both workers when neither opt-out is set", async () => {
    await register();

    expect(mockRegisterProcessErrorMonitor).toHaveBeenCalledTimes(1);
    expect(mockStartPaymentMaintenanceWorker).toHaveBeenCalledTimes(1);
    expect(mockStartEmailOutboxWorker).toHaveBeenCalledTimes(1);
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it("disabling payment maintenance does NOT prevent the email outbox worker from starting", async () => {
    process.env.PAYMENT_MAINTENANCE_WORKER = "off";

    await register();

    // The payment worker is skipped, but the email worker still starts —
    // password-reset delivery must not silently stop when payment
    // maintenance is disabled.
    expect(mockStartPaymentMaintenanceWorker).not.toHaveBeenCalled();
    expect(mockStartEmailOutboxWorker).toHaveBeenCalledTimes(1);
  });

  it("disabling the email outbox worker does NOT prevent the payment worker from starting", async () => {
    process.env.EMAIL_OUTBOX_WORKER = "off";

    await register();

    expect(mockStartEmailOutboxWorker).not.toHaveBeenCalled();
    expect(mockStartPaymentMaintenanceWorker).toHaveBeenCalledTimes(1);
  });

  it("disabling both workers starts neither", async () => {
    process.env.PAYMENT_MAINTENANCE_WORKER = "off";
    process.env.EMAIL_OUTBOX_WORKER = "off";

    await register();

    expect(mockStartPaymentMaintenanceWorker).not.toHaveBeenCalled();
    expect(mockStartEmailOutboxWorker).not.toHaveBeenCalled();
    // The process error monitor is independent of both workers.
    expect(mockRegisterProcessErrorMonitor).toHaveBeenCalledTimes(1);
  });

  it("starts neither worker outside the Node.js runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";

    await register();

    expect(mockRegisterProcessErrorMonitor).not.toHaveBeenCalled();
    expect(mockStartPaymentMaintenanceWorker).not.toHaveBeenCalled();
    expect(mockStartEmailOutboxWorker).not.toHaveBeenCalled();
  });

  it("starts neither worker during the production build phase", async () => {
    process.env.NEXT_PHASE = "phase-production-build";

    await register();

    expect(mockRegisterProcessErrorMonitor).not.toHaveBeenCalled();
    expect(mockStartPaymentMaintenanceWorker).not.toHaveBeenCalled();
    expect(mockStartEmailOutboxWorker).not.toHaveBeenCalled();
  });
});
