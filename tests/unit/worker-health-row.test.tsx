// @vitest-environment jsdom
// Worker health row (D15): the admin dashboard Operations card renders
// nothing for a healthy worker and a warning row — with the last successful
// sweep — for every unhealthy state. Runs under vitest + jsdom; plain DOM
// assertions only, no jest-dom dependency in this repo.
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { WorkerHeartbeatSnapshot } from "@/services/worker-heartbeat";
import { WorkerHealthRow } from "@/components/admin/worker-health-row";

afterEach(() => {
  cleanup();
});

function snapshot(overrides: Partial<WorkerHeartbeatSnapshot> = {}): WorkerHeartbeatSnapshot {
  return {
    status: "healthy",
    startedAt: "2026-11-20T10:00:00.000Z",
    lastSweepStartedAt: "2026-11-20T10:05:00.000Z",
    lastSweepCompletedAt: "2026-11-20T10:05:01.000Z",
    lastSuccessAt: "2026-11-20T10:05:01.000Z",
    lastFailureAt: null,
    lastFailureCode: null,
    consecutiveFailures: 0,
    sweepsCompleted: 12,
    sweepsFailed: 0,
    ageMs: 8_000,
    staleAfterMs: 180_000,
    ...overrides,
  };
}

describe("WorkerHealthRow", () => {
  it("renders nothing while both workers are healthy", () => {
    const { container } = render(
      <WorkerHealthRow worker={snapshot()} outboxWorker={snapshot()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows a stale worker with the last successful sweep age", () => {
    render(
      <WorkerHealthRow
        worker={snapshot({ status: "stale", ageMs: 12 * 60_000 })}
        outboxWorker={snapshot()}
      />,
    );
    expect(screen.getByText("Payment worker stale")).toBeTruthy();
    expect(screen.getByText(/last sweep 12 min ago/)).toBeTruthy();
  });

  it("shows a failing worker with the failure code and failed count", () => {
    render(
      <WorkerHealthRow
        worker={snapshot({
          status: "failing",
          ageMs: 45_000,
          sweepsFailed: 3,
          consecutiveFailures: 3,
          lastFailureCode: "SWEEP_FAILED",
          lastFailureAt: "2026-11-20T10:04:00.000Z",
        })}
        outboxWorker={snapshot()}
      />,
    );
    expect(screen.getByText("Payment worker failing")).toBeTruthy();
    expect(screen.getByText(/3 failed/)).toBeTruthy();
    expect(screen.getByText(/code SWEEP_FAILED/)).toBeTruthy();
  });

  it("shows a stopped worker", () => {
    render(
      <WorkerHealthRow
        worker={snapshot({ status: "stopped", ageMs: 30 * 60_000 })}
        outboxWorker={snapshot()}
      />,
    );
    expect(screen.getByText("Payment worker stopped")).toBeTruthy();
  });

  it("shows a never-started worker with no successful sweep yet", () => {
    render(
      <WorkerHealthRow
        worker={snapshot({
          status: "not_started",
          startedAt: null,
          lastSweepStartedAt: null,
          lastSweepCompletedAt: null,
          lastSuccessAt: null,
          ageMs: null,
          sweepsCompleted: 0,
        })}
        outboxWorker={snapshot()}
      />,
    );
    expect(screen.getByText("Payment worker not started")).toBeTruthy();
    expect(screen.getByText(/no successful sweep yet/)).toBeTruthy();
  });

  it("shows seconds when the last sweep was under a minute ago", () => {
    render(
      <WorkerHealthRow
        worker={snapshot({ status: "stale", ageMs: 45_000 })}
        outboxWorker={snapshot()}
      />,
    );
    expect(screen.getByText(/last sweep 45s ago/)).toBeTruthy();
  });

  // Stream F: the outbox worker has its own row. A healthy payment worker
  // must never mask a dead outbox worker — the card must not read
  // "All clear" while the outbox worker is stale, because PENDING emails
  // never become FAILED rows and the queue counts stay zero.

  it("shows a stale outbox worker even when the payment worker is healthy", () => {
    render(
      <WorkerHealthRow
        worker={snapshot()}
        outboxWorker={snapshot({ status: "stale", ageMs: 12 * 60_000 })}
      />,
    );
    expect(screen.getByText("Email outbox worker stale")).toBeTruthy();
    expect(screen.getByText(/last sweep 12 min ago/)).toBeTruthy();
    expect(screen.queryByText(/Payment worker/)).toBeNull();
  });

  it("shows a failing outbox worker with the failure code and failed count", () => {
    render(
      <WorkerHealthRow
        worker={snapshot()}
        outboxWorker={snapshot({
          status: "failing",
          ageMs: 45_000,
          sweepsFailed: 2,
          consecutiveFailures: 2,
          lastFailureCode: "SWEEP_FAILED",
          lastFailureAt: "2026-11-20T10:04:00.000Z",
        })}
      />,
    );
    expect(screen.getByText("Email outbox worker failing")).toBeTruthy();
    expect(screen.getByText(/2 failed/)).toBeTruthy();
    expect(screen.getByText(/code SWEEP_FAILED/)).toBeTruthy();
  });

  it("shows a never-started outbox worker with no successful sweep yet", () => {
    render(
      <WorkerHealthRow
        worker={snapshot()}
        outboxWorker={snapshot({
          status: "not_started",
          startedAt: null,
          lastSweepStartedAt: null,
          lastSweepCompletedAt: null,
          lastSuccessAt: null,
          ageMs: null,
          sweepsCompleted: 0,
        })}
      />,
    );
    expect(screen.getByText("Email outbox worker not started")).toBeTruthy();
    expect(screen.getByText(/no successful sweep yet/)).toBeTruthy();
  });

  it("shows both workers when both are unhealthy", () => {
    render(
      <WorkerHealthRow
        worker={snapshot({ status: "stopped", ageMs: 30 * 60_000 })}
        outboxWorker={snapshot({ status: "stale", ageMs: 12 * 60_000 })}
      />,
    );
    expect(screen.getByText("Payment worker stopped")).toBeTruthy();
    expect(screen.getByText("Email outbox worker stale")).toBeTruthy();
  });
});
