"use client";

// Banner image with graceful degradation (FR-12, FR-51, banner management task).
//
// Banners may reference: persistent storage uploads, root-relative public
// assets, or administrator-supplied external URLs. Trusted sources —
// root-relative local paths and the Supabase storage host already allowlisted
// in next.config.ts `images.remotePatterns` (and CSP_IMAGE_HOSTS) — render
// through next/image so they get optimization and proper LCP prioritisation.
// Arbitrary admin-pasted hosts must neither crash rendering nor require an
// unrestricted remote-hostname allowlist (security), so untrusted sources
// keep the plain <img> fallback exactly as before.
// Any load failure falls back to the store placeholder instead of a broken
// image box, so an unavailable remote image never breaks the storefront.
import Image from "next/image";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** The only remote host next/image may optimise: the Supabase storage host
 *  already in next.config.ts `images.remotePatterns` and CSP_IMAGE_HOSTS.
 *  Never widen this — no wildcards, no other hosts. */
const TRUSTED_REMOTE_HOST = "https://evsxjmtireufyymgsehx.supabase.co/";

function isTrustedSrc(src: string): boolean {
  return src.startsWith("/") || src.startsWith(TRUSTED_REMOTE_HOST);
}

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

  // The placeholder fallback is a root-relative local path, so it is trusted;
  // the `failed` flag already guards against looping if it fails too.
  if (isTrustedSrc(resolvedSrc)) {
    return (
      <Image
        src={resolvedSrc}
        alt={alt}
        // All three call sites render inside a `relative` container, so fill
        // covers it exactly like the previous absolute inset-0 <img>.
        fill
        sizes="(max-width: 768px) 100vw, 50vw"
        // First hero slide is the LCP element: priority replaces
        // fetchPriority/loading for it. The rest stay lazy.
        priority={eager}
        loading={eager ? "eager" : "lazy"}
        // Some hotlink-blocked servers reject requests with cross-site referrers.
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn(className)}
      />
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      // First hero slide is the LCP element: tell the browser to fetch it
      // ahead of other images. The rest stay lazy (see `eager` above).
      fetchPriority={eager ? "high" : undefined}
      decoding="async"
      // Some hotlink-blocked servers reject requests with cross-site referrers.
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn(className)}
    />
  );
}
