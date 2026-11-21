// Admin email-outbox retry button (Phase 3 Chunk 7, H-15). Client
// component: posts to the retry API route and reports the outcome inline.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function EmailOutboxRetryButton({ entryId }: { entryId: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  async function retry() {
    setState("pending");
    setMessage("");
    try {
      const res = await fetch(`/api/admin/email-outbox/${entryId}/retry`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) {
        setState("error");
        setMessage(body?.error ?? "Retry failed. Please try again.");
        return;
      }
      setState("done");
      setMessage("Re-enqueued — the worker will deliver it shortly.");
      router.refresh();
    } catch {
      setState("error");
      setMessage("Retry failed. Please try again.");
    }
  }

  return (
    <div className="space-y-2">
      <Button onClick={retry} disabled={state === "pending" || state === "done"}>
        {state === "pending" ? "Retrying…" : state === "done" ? "Re-enqueued" : "Retry delivery"}
      </Button>
      {message && (
        <p className={state === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {message}
        </p>
      )}
    </div>
  );
}
