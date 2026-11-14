import { HttpsWebhookTransport, publicOnlyLookup } from './webhook-transport';

describe('webhook transport', () => {
  it('refuses hostnames that resolve to non-public addresses', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      publicOnlyLookup('localhost', { family: 0 }, (err) => resolve(err)),
    );
    expect(error?.code).toBe('EBLOCKEDADDRESS');
  });

  it('reports a blocked address as a failed delivery, not a crash', async () => {
    const response = await new HttpsWebhookTransport().post(
      'https://localhost:9/hook',
      '{}',
      { 'content-type': 'application/json' },
      2_000,
    );
    expect(response.status).toBeNull();
    expect(response.error).toContain('non-public');
  });
});
