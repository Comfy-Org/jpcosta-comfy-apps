/**
 * Browser fetch helpers for a run that has already been accepted.
 *
 * Chrome reports `TypeError: Failed to fetch` both when `fetch()` itself
 * fails and when `response.blob()` fails because a 200 body is reset or
 * shorter than Content-Length. The server can already have logged 200.
 */

export const OUTPUT_FETCH_ATTEMPTS = 3;

export type ClientStep = "submit" | "status" | "download";

export type BlobResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  blob(): Promise<Blob>;
  text(): Promise<string>;
};

export function isTransientFetchError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message) : "";
  if (name === "AbortError") return false;
  return name === "TypeError" && /failed to fetch|networkerror|load failed|network request failed|network error/i.test(message);
}

export function clientFailureMessage(step: ClientStep, error: unknown): string {
  const raw = error instanceof Error && error.message ? error.message : "The request failed.";
  if (!isTransientFetchError(error)) return raw;
  if (step === "download") {
    return `Could not download the finished video (${raw}). Retry the download. This job already finished.`;
  }
  if (step === "status") {
    return `Could not read job status (${raw}). Check the job again. It was already submitted.`;
  }
  return `Could not submit the run (${raw}). Try again.`;
}

function declaredLength(response: BlobResponse): number | null {
  const raw = response.headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export async function fetchBlobRetrying(
  url: string,
  init: RequestInit | undefined,
  fetchImpl: (url: string, init?: RequestInit) => Promise<BlobResponse>,
  attempts = OUTPUT_FETCH_ATTEMPTS,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ response: BlobResponse; blob: Blob | null }> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const response = await fetchImpl(url, init);
      if (!response.ok) return { response, blob: null };
      const blob = await response.blob();
      const expected = declaredLength(response);
      if (expected !== null && blob.size !== expected) {
        throw new TypeError("Failed to fetch");
      }
      return { response, blob };
    } catch (error) {
      last = error;
      const aborted = Boolean(init?.signal?.aborted) || (error instanceof Error && error.name === "AbortError");
      if (aborted || !isTransientFetchError(error) || attempt === attempts - 1) throw error;
      await wait(400 * (attempt + 1));
    }
  }
  throw last;
}
