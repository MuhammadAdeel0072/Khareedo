// Admin review moderation actions (Phase 3, Chunk 9 — D13). Client
// component: PATCHes the moderation API route and refreshes the queue.
// Approve/reject are idempotent server-side, so a double-click is harmless.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function ReviewModerationActions({ reviewId }: { reviewId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"APPROVED" | "REJECTED" | null>(null);
  const [message, setMessage] = useState<string>("");

  async function moderate(action: "APPROVED" | "REJECTED") {
    setBusy(action);
    setMessage("");
    try {
      const res = await fetch(`/api/admin/reviews/${reviewId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) {
        setMessage(body?.error ?? "Moderation failed. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setMessage("Moderation failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Button size="sm" onClick={() => moderate("APPROVED")} disabled={busy !== null}>
          {busy === "APPROVED" ? "Approving…" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => moderate("REJECTED")}
          disabled={busy !== null}
        >
          {busy === "REJECTED" ? "Rejecting…" : "Reject"}
        </Button>
      </div>
      {message && <p className="text-xs text-destructive">{message}</p>}
    </div>
  );
}
