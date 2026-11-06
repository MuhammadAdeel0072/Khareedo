export interface AdminApiResponse {
  ok: boolean;
  error?: string;
  url?: string;
  product?: Record<string, unknown>;
  errors?: Record<string, string>;
}

function statusMessage(status: number) {
  if (status === 401) return "Your admin session has expired. Please sign in again.";
  if (status === 403) return "You do not have permission to perform this action.";
  if (status === 413) return "The image is too large. Maximum size is 5 MB.";
  if (status === 415) return "This image format is not supported.";
  if (status === 422) return "Please correct the highlighted fields.";
  if (status >= 500) return "The server could not complete the request. Please try again.";
  return "The server returned an unexpected response. Please try again.";
}

export async function readAdminApiResponse(
  response: Response
): Promise<AdminApiResponse> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: statusMessage(response.status) };
  }

  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: statusMessage(response.status) };
  }

  const data = payload as Record<string, unknown>;
  const errors =
    typeof data.errors === "object" && data.errors !== null
      ? Object.fromEntries(
          Object.entries(data.errors).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : undefined;

  return {
    ok: data.ok === true,
    error: typeof data.error === "string" ? data.error : undefined,
    url: typeof data.url === "string" ? data.url : undefined,
    product:
      typeof data.product === "object" && data.product !== null
        ? (data.product as Record<string, unknown>)
        : undefined,
    errors,
  };
}

export function adminApiErrorMessage(response: Response, data: AdminApiResponse) {
  return data.error || statusMessage(response.status);
}
