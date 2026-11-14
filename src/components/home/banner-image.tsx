"use client";

// Banner image with graceful degradation (FR-12, FR-51, banner management task).
//
// Banners may reference: persistent storage uploads, root-relative public
// assets, or administrator-supplied external URLs. A plain <img> is used
// deliberately — Next.js image optimization only allows pre-registered
// hostnames, and arbitrary admin-pasted hosts must neither crash rendering
// nor require an unrestricted remote-hostname allowlist (security).
// Any load failure falls back to the store placeholder instead of a broken
// image box, so an unavailable remote image never breaks the storefront.
import { useState } from "react";
import { cn } from "@/lib/utils";

export function BannerImage({
  src,
  alt,
  className,
  eager = false,
}: {
  src: string;
  alt: string;
  className?: string;
  /** First hero slide renders eagerly (LCP); the rest lazy-load. */
  eager?: boolean;
}) {
  const [prevSrc, setPrevSrc] = useState(src);
  const [failed, setFailed] = useState(false);

  // A new src must get a fresh chance to load (render-time state adjustment —
  // the React-recommended alternative to a resetting effect).
  if (src !== prevSrc) {
    setPrevSrc(src);
    setFailed(false);
  }

  const resolvedSrc = failed || !src ? "/images/placeholder.svg" : src;

  return (
    <img
      src={resolvedSrc}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      // Some hotlink-blocked servers reject requests with cross-site referrers.
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn(className)}
    />
  );
}
