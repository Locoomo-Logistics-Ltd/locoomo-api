import {
  FetchPolicy,
  fetchWithPolicy,
} from '../../../../common/http/fetch-with-policy';
import { LogisticsProviderError } from '../../domain/ports/logistics-provider.port';
import type { SendiiEnvelope } from './sendii-api.types';

export const SENDII_KEY = 'sendii';

// Reads are safe to repeat. POST /deliveries is too — external_ref makes a
// replay return the existing delivery (409) instead of creating another.
export const SENDII_READ_POLICY: FetchPolicy = {
  timeoutMs: 10_000,
  retries: 2,
};
export const SENDII_WRITE_POLICY: FetchPolicy = {
  timeoutMs: 15_000,
  retries: 1,
};

export interface SendiiCallOptions {
  baseUrl: string;
  apiKey: string;
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | number>;
  body?: unknown;
  policy: FetchPolicy;
}

export interface SendiiResult<T> {
  status: number;
  envelope: SendiiEnvelope<T>;
}

// One call to Sendii. Turns "no usable answer" (network, timeout, a non-JSON
// body, 429, 5xx) into a *retryable* LogisticsProviderError, and refusals
// that retrying can't fix (validation, auth/KYC, no balance, paused,
// unknown id) into a non-retryable one — the dispatcher then moves the
// order to the next courier. 409 CONFLICT is returned to the caller, which
// decides what it means (createDelivery: "already exists").
export async function sendiiRequest<T>(
  operation: string,
  path: string,
  options: SendiiCallOptions,
): Promise<SendiiResult<T>> {
  const url = new URL(`${options.baseUrl.replace(/\/+$/, '')}${path}`);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(name, String(value));
  }

  let response: Response;
  try {
    response = await fetchWithPolicy(
      url.toString(),
      {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          ...(options.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
      },
      options.policy,
    );
  } catch (error) {
    const { name, message } = (error ?? {}) as {
      name?: unknown;
      message?: unknown;
    };
    throw new LogisticsProviderError(
      SENDII_KEY,
      operation,
      name === 'TimeoutError'
        ? `timed out after ${options.policy.timeoutMs}ms`
        : `network error: ${typeof message === 'string' ? message : String(error)}`,
      true,
    );
  }

  let envelope: SendiiEnvelope<T>;
  try {
    envelope = (await response.json()) as SendiiEnvelope<T>;
  } catch {
    throw new LogisticsProviderError(
      SENDII_KEY,
      operation,
      `non-JSON response (HTTP ${response.status})`,
      true,
    );
  }

  if (envelope.success || response.status === 409) {
    return { status: response.status, envelope };
  }
  const code = envelope.error?.code ?? `HTTP_${response.status}`;
  const detail = `${code}: ${envelope.error?.message ?? 'no message'}`;
  const retryable = response.status === 429 || response.status >= 500;
  throw new LogisticsProviderError(SENDII_KEY, operation, detail, retryable);
}

export function nairaToKobo(naira: number): number {
  return Math.round(naira * 100);
}
