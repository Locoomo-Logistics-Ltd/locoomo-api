// Thin wrapper over native fetch for calls to third-party APIs (payments,
// email, couriers). Adds the two things bare fetch never does: a hard
// timeout, and bounded retries for failures that are worth retrying.
//
// Retries are opt-in per call (`retries`, default 0) because only the caller
// knows whether a request is safe to repeat — a GET is; a POST that creates
// something is only safe if the provider deduplicates it (an idempotency key
// or external reference). Never pass retries > 0 for a non-idempotent call.

export interface FetchPolicy {
  // Per attempt, not total. Default 10s.
  timeoutMs?: number;
  // Extra attempts after the first. Default 0.
  retries?: number;
  // First backoff delay; doubles per retry. Default 500ms.
  baseDelayMs?: number;
  // Upper bound for any single wait, including a server's Retry-After —
  // a provider asking us to wait minutes is a failure, not a retry.
  maxDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5_000;

// 408 Request Timeout, 429 Too Many Requests, and the 5xx statuses that
// mean "transient upstream trouble". Other 4xx/5xx are the caller's problem
// and are returned as-is on the first attempt.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export async function fetchWithPolicy(
  url: string,
  init: RequestInit = {},
  policy: FetchPolicy = {},
): Promise<Response> {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = policy.retries ?? 0;
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt >= retries;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Network failure or timeout (AbortSignal.timeout rejects with a
      // TimeoutError DOMException).
      if (isLastAttempt) {
        throw error;
      }
      await sleep(Math.min(baseDelayMs * 2 ** attempt, maxDelayMs));
      continue;
    }

    if (isLastAttempt || !RETRYABLE_STATUSES.has(response.status)) {
      return response;
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    // Release the connection before waiting — the body won't be read.
    await response.body?.cancel();
    await sleep(
      Math.min(retryAfterMs ?? baseDelayMs * 2 ** attempt, maxDelayMs),
    );
  }
}

// Retry-After is either delta-seconds or an HTTP date.
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
