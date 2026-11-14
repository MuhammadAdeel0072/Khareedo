"use client";

import Image, { type ImageProps } from "next/image";
import { useState } from "react";

const FALLBACK_IMAGE = "/images/placeholder.svg";
const PRODUCT_STORAGE_PATH = "/storage/v1/object/public/product-images/";

type ProductImageProps = Omit<
  ImageProps,
  "src" | "alt" | "onError" | "unoptimized"
> & {
  src?: string | null;
  alt: string;
};

function normalizeImageSource(src: string | null | undefined): string {
  if (!src) return FALLBACK_IMAGE;
  if (
    src.startsWith("/") &&
    !src.startsWith("//") &&
    !src.includes("\\") &&
    !/[\u0000-\u001f]/.test(src)
  ) {
    return src;
  }

  try {
    const url = new URL(src);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    ) {
      return url.toString();
    }
  } catch {
    return FALLBACK_IMAGE;
  }

  return FALLBACK_IMAGE;
}

function isProductStorageImage(src: string): boolean {
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!projectUrl || src.startsWith("/")) return false;

  try {
    const imageUrl = new URL(src);
    const storageUrl = new URL(projectUrl);
    return (
      imageUrl.protocol === "https:" &&
      imageUrl.origin === storageUrl.origin &&
      imageUrl.pathname.startsWith(PRODUCT_STORAGE_PATH)
    );
  } catch {
    return false;
  }
}

export function ProductImage({ src, alt, ...props }: ProductImageProps) {
  const source = normalizeImageSource(src);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const displayedSource =
    failedSource === source ? FALLBACK_IMAGE : source;

  return (
    <Image
      {...props}
      src={displayedSource}
      alt={alt}
      unoptimized={
        displayedSource !== FALLBACK_IMAGE &&
        !displayedSource.startsWith("/") &&
        !isProductStorageImage(displayedSource)
      }
      onError={() => {
        if (displayedSource !== FALLBACK_IMAGE) setFailedSource(source);
      }}
    />
  );
}
