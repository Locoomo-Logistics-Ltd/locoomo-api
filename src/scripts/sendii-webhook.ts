import 'dotenv/config';

// Manages this environment's webhook endpoint at Sendii (the API key's
// prefix decides sandbox vs live). Usage:
//   npm run sendii:webhook -- register https://api.example.com
//   npm run sendii:webhook -- list
//   npm run sendii:webhook -- test <endpoint-id>
//   npm run sendii:webhook -- delete <endpoint-id>
// `register` appends /api/v1/logistics/webhooks/sendii to the base URL you
// give and prints the signing secret — shown by Sendii only once; put it in
// SENDII_WEBHOOK_SECRET. Sendii only accepts public HTTPS URLs; for local
// development expose the API with a tunnel (cloudflared, ngrok) first.

const WEBHOOK_PATH = '/api/v1/logistics/webhooks/sendii';

async function call(method: string, path: string, body?: unknown) {
  const apiKey = process.env.SENDII_API_KEY;
  if (!apiKey) {
    throw new Error('SENDII_API_KEY is not set');
  }
  const base =
    process.env.SENDII_BASE_URL ?? 'https://api.sendii.ng/partner/v1';
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json()) as {
    success: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  };
  if (!payload.success) {
    throw new Error(
      `Sendii ${method} ${path} failed: ${payload.error?.code} ${payload.error?.message}`,
    );
  }
  return payload.data;
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  switch (command) {
    case 'register': {
      if (!argument?.startsWith('https://')) {
        throw new Error(
          'register needs the public https:// base URL of this API',
        );
      }
      const url = `${argument.replace(/\/+$/, '')}${WEBHOOK_PATH}`;
      const created = (await call('POST', '/webhooks', { url })) as {
        id: string;
        environment: string;
        signing_secret: string;
      };
      console.log(
        `Registered ${url} (${created.environment}), id ${created.id}`,
      );
      console.log(
        'Set this in the environment now — Sendii will not show it again:',
      );
      console.log(`SENDII_WEBHOOK_SECRET=${created.signing_secret}`);
      return;
    }
    case 'list':
      console.log(JSON.stringify(await call('GET', '/webhooks'), null, 2));
      return;
    case 'test':
      await call('POST', `/webhooks/${encodeURIComponent(argument)}/test`);
      console.log('Ping queued — watch the API logs for the delivery.');
      return;
    case 'delete':
      await call('DELETE', `/webhooks/${encodeURIComponent(argument)}`);
      console.log(`Deleted ${argument}`);
      return;
    default:
      throw new Error(
        'usage: sendii:webhook -- register <https-base-url> | list | test <id> | delete <id>',
      );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
