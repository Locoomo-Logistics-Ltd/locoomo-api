import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

// Public, versioned contract for external merchants (plan §12, E13). Only
// these path prefixes are published — internal consumer/Node/rider/admin
// routes stay out of the merchant-facing document.
export const MERCHANT_OPENAPI_PATH_PREFIXES = ['/api/v1/merchant'];
export const MERCHANT_OPENAPI_JSON_URL = '/api/v1/merchant/openapi.json';

export function buildMerchantOpenApiDocument(
  app: INestApplication,
): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Locoomo Merchant API')
    .setDescription(
      [
        'Create and track shipments through the Locoomo pickup-station network.',
        '',
        'Auth: `Authorization: Bearer sk_test_…` / `sk_live_…` (server-side) or',
        '`pk_…` (browser, Nodes and quotes only).',
        'Every response is wrapped as `{ success, data, meta }` / `{ success: false, error }`;',
        'branch on `error.code`. Stability: additive changes only within v1 —',
        'tolerate unknown fields, enum values and webhook event types.',
      ].join('\n'),
    )
    .setVersion('1')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', description: 'sk_… or pk_… API key' },
      'apiKey',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.paths = Object.fromEntries(
    Object.entries(document.paths).filter(([path]) =>
      MERCHANT_OPENAPI_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
    ),
  );
  return document;
}

// JSON only (no bundled UI): frontend/integrator tooling (openapi-typescript,
// Postman, Redoc) consumes the spec; the API serves no HTML.
export function mountMerchantOpenApi(app: INestApplication): void {
  SwaggerModule.setup(
    'api/v1/merchant/docs',
    app,
    () => buildMerchantOpenApiDocument(app),
    {
      ui: false,
      raw: ['json'],
      jsonDocumentUrl: MERCHANT_OPENAPI_JSON_URL,
    },
  );
}
