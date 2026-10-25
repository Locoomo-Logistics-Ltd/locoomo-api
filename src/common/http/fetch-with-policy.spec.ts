import { fetchWithPolicy, parseRetryAfterMs } from './fetch-with-policy';

describe('fetchWithPolicy', () => {
  let fetchSpy: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const fast = { baseDelayMs: 1, maxDelayMs: 5 };

  it('returns the first response when retries are not enabled', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 503 }));

    const response = await fetchWithPolicy('https://x.test', {}, fast);

    expect(response.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable status and returns the eventual success', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const response = await fetchWithPolicy(
      'https://x.test',
      {},
      { ...fast, retries: 2 },
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable client error', async () => {
    fetchSpy.mockResolvedValue(new Response('bad', { status: 400 }));

    const response = await fetchWithPolicy(
      'https://x.test',
      {},
      { ...fast, retries: 3 },
    );

    expect(response.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the last retryable response once retries are exhausted', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response('slow down', { status: 429 })),
    );

    const response = await fetchWithPolicy(
      'https://x.test',
      {},
      { ...fast, retries: 2 },
    );

    expect(response.status).toBe(429);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('retries network errors, then rethrows the last one', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      fetchWithPolicy('https://x.test', {}, { ...fast, retries: 1 }),
    ).rejects.toThrow('fetch failed');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('passes an abort signal so a hung request times out', async () => {
    fetchSpy.mockResolvedValue(new Response('ok'));

    await fetchWithPolicy('https://x.test', { method: 'POST' }, fast);

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('3')).toBe(3000);
  });

  it('parses an HTTP date', () => {
    const inTwoSeconds = new Date(Date.now() + 2000).toUTCString();
    const ms = parseRetryAfterMs(inTwoSeconds);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(2000);
  });

  it('returns null for a missing or garbage header', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
  });
});
