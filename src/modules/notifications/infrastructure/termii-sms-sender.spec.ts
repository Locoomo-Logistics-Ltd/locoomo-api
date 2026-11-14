import { TermiiSmsSender } from './termii-sms-sender';

const config = {
  apiKey: 'test-key',
  baseUrl: 'https://termii.example/',
  senderId: 'Locoomo',
  channel: 'generic' as const,
};

function mockFetch(status: number, body: unknown): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    }),
  );
}

describe('TermiiSmsSender', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends to the number without its leading + and returns the message id', async () => {
    const fetchSpy = mockFetch(200, { message_id: 'abc' });
    const sender = new TermiiSmsSender(config);

    const result = await sender.send({ to: '+2348031234567', body: 'hi' });

    expect(result).toEqual({ status: 'sent', providerMessageId: 'abc' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://termii.example/api/sms/send');
    expect(JSON.parse(init.body as string)).toMatchObject({
      to: '2348031234567',
      from: 'Locoomo',
      sms: 'hi',
      channel: 'generic',
    });
  });

  it('disables itself after the provider rejects the key, without retrying', async () => {
    const fetchSpy = mockFetch(401, 'unauthorised');
    const sender = new TermiiSmsSender(config);

    const first = await sender.send({ to: '+2348031234567', body: 'a' });
    const second = await sender.send({ to: '+2348031234567', body: 'b' });

    expect(first.status).toBe('skipped');
    expect(second.status).toBe('skipped');
    expect(sender.isEnabled()).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('skips (does not throw) when the provider refuses a single message', async () => {
    mockFetch(400, { message: 'invalid number' });
    const sender = new TermiiSmsSender(config);

    const result = await sender.send({ to: '+2348031234567', body: 'a' });

    expect(result.status).toBe('skipped');
    expect(sender.isEnabled()).toBe(true);
  });

  it('throws on transient provider failure so the outbox retries', async () => {
    mockFetch(503, 'down');
    const sender = new TermiiSmsSender(config);

    await expect(
      sender.send({ to: '+2348031234567', body: 'a' }),
    ).rejects.toThrow('transient');
  });
});
