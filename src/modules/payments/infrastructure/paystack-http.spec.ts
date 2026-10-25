import { PaymentProviderException } from '../domain/exceptions/payment-provider.exception';
import { paystackRequest } from './paystack-http';

describe('paystackRequest', () => {
  let fetchSpy: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;
  const policy = { timeoutMs: 50, retries: 0 };

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns the parsed body and response on success', async () => {
    fetchSpy.mockResolvedValue(
      Response.json({ status: true, data: { ok: 1 } }),
    );

    const { response, body } = await paystackRequest<{
      status: boolean;
      data: { ok: number };
    }>('verify', '/transaction/verify/x', {}, policy);

    expect(response.status).toBe(200);
    expect(body.data.ok).toBe(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.paystack.co/transaction/verify/x',
    );
  });

  it('hands a status:false JSON body back to the caller instead of throwing', async () => {
    fetchSpy.mockResolvedValue(
      Response.json({ status: false, message: 'nope' }, { status: 400 }),
    );

    const { response, body } = await paystackRequest(
      'verify',
      '/x',
      {},
      policy,
    );

    expect(response.status).toBe(400);
    expect(body.status).toBe(false);
  });

  it('maps a network failure to PAYMENT_PROVIDER_ERROR', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    const error = await paystackRequest('initialize', '/x', {}, policy).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PaymentProviderException);
    expect((error as PaymentProviderException).httpStatus).toBe(502);
    expect((error as Error).message).toContain('network error: fetch failed');
  });

  it('maps a timeout to PAYMENT_PROVIDER_ERROR', async () => {
    fetchSpy.mockRejectedValue(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    );

    await expect(
      paystackRequest('initialize', '/x', {}, policy),
    ).rejects.toThrow(/initialize failed: timed out after 50ms/);
  });

  it('maps a non-JSON body (gateway error page) to PAYMENT_PROVIDER_ERROR', async () => {
    fetchSpy.mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );

    await expect(paystackRequest('refund', '/x', {}, policy)).rejects.toThrow(
      /refund failed: non-JSON response \(HTTP 502\)/,
    );
  });
});
