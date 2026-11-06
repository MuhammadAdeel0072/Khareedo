import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  options: undefined as any,
  extension: undefined as any,
  queryListener: undefined as ((event: any) => void) | undefined,
}));

vi.mock("../../generated/postgres-client", () => ({
  PrismaClient: class {
    constructor(options: unknown) { client.options = options; }
    $on(event: string, listener: (event: any) => void) {
      if (event === "query") client.queryListener = listener;
    }
    $extends(extension: unknown) { client.extension = extension; return this; }
  },
}));

describe("opt-in production performance diagnostics", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOG_LEVEL", "error");
    vi.stubEnv("SUPABASE_POSTGRES_URL", "postgresql://diagnostic:unused@localhost:5432/unused");
    vi.stubEnv("SUPABASE_DB_CA_CERT", "");
    client.options = undefined;
    client.extension = undefined;
    client.queryListener = undefined;
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps default production calls quiet and preserves their results", async () => {
    const timing = await import("@/lib/performance-timing");
    const result = { currentPrice: 1234 };
    expect(timing.isPerformanceLoggingEnabled).toBe(false);
    expect(await timing.withPerformanceMeasurement("homepage.products", () => {
      expect(timing.getPerformanceContext()).toBeUndefined();
      return result;
    })).toBe(result);
    expect(await timing.withPerformanceTiming("cart.count", async () => 3)).toBe(3);
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("keeps debug request context without logging fast operations", async () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const timing = await import("@/lib/performance-timing");
    expect(timing.isPerformanceLoggingEnabled).toBe(true);
    await timing.withPerformanceMeasurement("homepage.products", async () => {
      expect(timing.getPerformanceContext()).toEqual({ requestId: "request-a", operation: "homepage.products" });
      await timing.withPerformanceTiming("products.read", async () => {
        expect(timing.getPerformanceContext()).toEqual({ requestId: "request-a", operation: "products.read" });
      });
      expect(timing.getPerformanceContext()?.operation).toBe("homepage.products");
    }, "request-a");
    expect(timing.getPerformanceContext()).toBeUndefined();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("logs only a concise warning when an operation is slow", async () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const timing = await import("@/lib/performance-timing");
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1_200);

    await timing.withPerformanceMeasurement(
      "homepage.products",
      async () => undefined,
      "request-a"
    );

    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "[performance:slow] operation=homepage.products durationMs=1200"
    );
  });

  it("keeps concurrent request contexts separate", async () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const timing = await import("@/lib/performance-timing");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = timing.withPerformanceMeasurement("homepage.a", async () => {
      await gate;
      expect(timing.getPerformanceContext()?.requestId).toBe("request-a");
    }, "request-a");
    await timing.withPerformanceMeasurement("homepage.b", async () => {
      expect(timing.getPerformanceContext()?.requestId).toBe("request-b");
      release();
    }, "request-b");
    await first;
    expect(timing.getPerformanceContext()).toBeUndefined();
  });

  it("preserves errors without logging normal operation details", async () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const timing = await import("@/lib/performance-timing");
    const failure = new Error("private-token-must-not-appear");
    await expect(timing.withPerformanceMeasurement("homepage.read", () => { throw failure; }, "request-a"))
      .rejects.toBe(failure);
    await expect(timing.withPerformanceTiming("homepage.read", async () => { throw failure; }, "request-a"))
      .rejects.toBe(failure);
    expect(timing.getPerformanceContext()).toBeUndefined();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("does not enable SQL events or operation logging in normal production", async () => {
    await import("@/lib/db");
    expect(client.queryListener).toBeUndefined();
    expect(client.options.log).toEqual(["error"]);
    const query = vi.fn().mockResolvedValue({ rows: 2 });
    const args = { select: { id: true } };
    expect(await client.extension.query.$allOperations({ model: "Product", operation: "findMany", args, query }))
      .toEqual({ rows: 2 });
    expect(query).toHaveBeenCalledWith(args);
    expect(console.info).not.toHaveBeenCalled();
  });

  it("keeps debug database calls quiet unless an operation is slow", async () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    await import("@/lib/db");
    const timing = await import("@/lib/performance-timing");
    const query = vi.fn().mockResolvedValue([1]);
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1_200)
      .mockReturnValueOnce(1_200);

    await timing.withPerformanceMeasurement("homepage.read", async () => {
      await client.extension.query.$allOperations({
        model: "Product",
        operation: "findMany",
        args: { where: { id: "private-token-must-not-appear" } },
        query,
      });
    }, "request-a");
    expect(client.queryListener).toBeUndefined();
    expect(client.options.log).toEqual(["error"]);
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "[performance:slow] database=Product.findMany durationMs=1200"
    );
  });
});
