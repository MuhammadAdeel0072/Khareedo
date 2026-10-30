// Khareedo shared helpers — formatting + class merge.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format integer PKR as "Rs 5,699" (mockup style — no decimals). */
export function formatPKR(amount: number): string {
  const n = Math.max(0, Math.round(amount));
  return `Rs ${n.toLocaleString("en-PK")}`;
}

/** Format a date like "15 Mar 2024". */
export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return `${formatDate(date)}, ${date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Unique, human-readable order reference, e.g. KH26031578912 (FR-24). */
export function generateOrderReference(): string {
  const now = new Date();
  const y = String(now.getFullYear()).slice(2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const rand = String(Math.floor(1000000 + Math.random() * 9000000)); // 7 digits
  return `KH${y}${m}${day}${rand}`;
}

export function truncate(text: string, len = 80): string {
  if (text.length <= len) return text;
  return `${text.slice(0, len - 1)}…`;
}

export function initials(name?: string | null): string {
  if (!name) return "U";
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
export { discountPercent } from "./pricing";
