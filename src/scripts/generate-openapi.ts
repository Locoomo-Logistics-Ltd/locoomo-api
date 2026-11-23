import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { AppModule } from '../app.module';
import { configureApp } from '../bootstrap';
import { buildMerchantOpenApiDocument } from '../openapi/openapi';
import { toPostmanCollection } from '../openapi/postman';

// `npm run openapi:generate` — builds first (the @nestjs/swagger compiler
// plugin only runs in `nest build`, so ts-node would drop fields), then writes the merchant OpenAPI document to
// doc/openapi/merchant.json so it's versioned with the code (and diffable
// in review), plus the Postman collection made from it.
const OUTPUT = 'doc/openapi/merchant.json';
const POSTMAN = 'doc/openapi/locoomo-merchant.postman_collection.json';
const PRODUCTION_HOST = 'https://api.locoomo.com';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  configureApp(app);
  const document = buildMerchantOpenApiDocument(app);
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(
    POSTMAN,
    `${JSON.stringify(toPostmanCollection(document, PRODUCTION_HOST), null, 2)}\n`,
  );
  await app.close();
  console.log(`Wrote ${OUTPUT} (${Object.keys(document.paths).length} paths)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
