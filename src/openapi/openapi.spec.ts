import type { OpenAPIObject } from '@nestjs/swagger';
import { pruneUnusedSchemas } from './openapi';

describe('merchant OpenAPI document', () => {
  it('keeps only schemas the public paths reference, transitively', () => {
    const document = {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: {
        '/a': {
          get: {
            responses: {
              200: {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Outer' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Outer: {
            type: 'object',
            properties: { inner: { $ref: '#/components/schemas/Inner' } },
          },
          Inner: { type: 'object' },
          AdminOnlyDto: { type: 'object' },
        },
      },
    } as unknown as OpenAPIObject;
    pruneUnusedSchemas(document);
    expect(Object.keys(document.components!.schemas!)).toEqual([
      'Outer',
      'Inner',
    ]);
  });
});
