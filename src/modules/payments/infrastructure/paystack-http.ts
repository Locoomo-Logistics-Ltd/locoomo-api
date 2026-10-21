import {
  FetchPolicy,
  fetchWithPolicy,
} from '../../../common/http/fetch-with-policy';
import { PaymentProviderException } from '../domain/exceptions/payment-provider.exception';

export const PAYSTACK_BASE_URL = 'https://api.paystack.co';

// Writes (initialize, refund) get a timeout only — a replayed initialize is
// rejected as a duplicate reference, and a replayed refund could double-pay.
// Reads are safe to repeat.
export const PAYSTACK_WRITE_POLICY: FetchPolicy = { timeoutMs: 15_000 };
export const PAYSTACK_READ_POLICY: FetchPolicy = {
  timeoutMs: 15_000,
  retries: 2,
};

// Every Paystack response body starts with these two fields.
export interface PaystackEnvelope {
  status: boolean;
  message?: string;
}

// One place that turns "Paystack didn't give us a usable answer" into
// PaymentProviderException (502 PAYMENT_PROVIDER_ERROR) — network failure,
// timeout, or a body that isn't JSON (a gateway's HTML error page). Without
// this those surfaced as a generic 500. Business-level failures (a JSON body
// with status: false) are returned for the caller to interpret, since what
// they mean differs per endpoint.
export async function paystackRequest<T extends PaystackEnvelope>(
  operation: string,
  path: string,
  init: RequestInit,
  policy: FetchPolicy,
): Promise<{ response: Response; body: T }> {
  let response: Response;
  try {
    response = await fetchWithPolicy(
      `${PAYSTACK_BASE_URL}${path}`,
      init,
      policy,
    );
  } catch (error) {
    // Checked by name, not instanceof: AbortSignal.timeout rejects with a
    // DOMException, which isn't always an Error instance across realms.
    const { name, message } = (error ?? {}) as {
      name?: unknown;
      message?: unknown;
    };
    const detail =
      name === 'TimeoutError'
        ? `timed out after ${policy.timeoutMs}ms`
        : `network error: ${typeof message === 'string' ? message : String(error)}`;
    throw new PaymentProviderException('paystack', operation, detail);
  }

  let body: T;
  try {
    body = (await response.json()) as T;
  } catch {
    throw new PaymentProviderException(
      'paystack',
      operation,
      `non-JSON response (HTTP ${response.status})`,
    );
  }

  return { response, body };
}

// A response that says Paystack itself is struggling, regardless of what the
// body claims — used where a status:false body would otherwise be read as a
// verdict on the caller's input (see PaystackBankService).
export function isPaystackOutage(response: Response): boolean {
  return response.status >= 500 || response.status === 429;
}
