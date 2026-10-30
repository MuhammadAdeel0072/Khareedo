const CALLBACK_ORIGIN = "https://khareedo.invalid";

export function safeCallbackUrl(value: string | null | undefined, fallback = "/account") {
  if (!value) return fallback;
  try {
    const url = new URL(value, CALLBACK_ORIGIN);
    if (url.origin !== CALLBACK_ORIGIN) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
