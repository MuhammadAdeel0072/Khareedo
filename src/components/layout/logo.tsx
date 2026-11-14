import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

/** Khareedo logo wordmark. */
export function Logo({
  className,
}: {
  className?: string;
}) {
  return (
    <Link
      href="/"
      aria-label="Khareedo home"
      className={cn("inline-flex items-center gap-2 shrink-0", className)}
    >
      <Image
        src="/logo.svg"
        alt="Khareedo"
        width={520}
        height={110}
        priority
        className="h-9 w-auto max-[359px]:h-7"
      />
    </Link>
  );
}
