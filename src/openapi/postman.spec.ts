import type { OpenAPIObject } from '@nestjs/swagger';
import { exampleOf, toPostmanCollection } from './postman';

const document = {
  openapi: '3.0.0',
  info: { title: 'Locoomo Merchant API', version: '1', description: 'Docs' },
  components: {
    securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } },
    schemas: {
      CreateShipmentDto: {
        type: 'object',
        required: ['reference', 'parcel'],
        properties: {
          reference: { type: 'string', example: 'ORD-1001' },
          notes: { type: 'string' },
          parcel: { $ref: '#/components/schemas/ParcelDto' },
        },
      },
      ParcelDto: {
        type: 'object',
        required: ['size', 'weightKg'],
        properties: {
          size: { type: 'string', enum: ['small', 'medium'] },
          weightKg: { type: 'number', minimum: 0.1 },
        },
      },
    },
  },
  paths: {
    '/api/v1/merchant/shipments': {
      post: {
        tags: ['Shipments'],
        summary: 'Create a shipment',
        security: [{ apiKey: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateShipmentDto' },
            },
          },
        },
      },
      get: {
        tags: ['Shipments'],
        security: [{ apiKey: [] }],
        parameters: [
          { name: 'limit', in: 'query', required: false },
          { name: 'status', in: 'query', required: true },
        ],
      },
    },
    '/api/v1/merchant/shipments/{id}': {
      get: {
        tags: ['Shipments'],
        summary: 'Get a shipment',
        security: [{ apiKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true }],
      },
    },
    '/api/v1/merchant/exports/download': {
      get: { tags: ['Reports'], summary: 'Download an export' },
    },
  },
} as unknown as OpenAPIObject;

describe('toPostmanCollection', () => {
  const collection = toPostmanCollection(document, 'https://api.locoomo.com/');

  it('groups requests by tag and points at {{baseUrl}}', () => {
    expect(collection.item.map((f) => f.name)).toEqual([
      'Reports',
      'Shipments',
    ]);
    expect(collection.variable).toContainEqual({
      key: 'baseUrl',
      value: 'https://api.locoomo.com/api/v1',
    });
    expect(collection.auth.bearer[0].value).toBe('{{secretKey}}');
  });

  it('builds URLs, parameters and a minimal example body', () => {
    const shipments = collection.item.find((f) => f.name === 'Shipments')!;
    const create = shipments.item.find((i) => i.request.method === 'POST')!;
    expect(create.name).toBe('Create a shipment');
    expect(create.request.url.raw).toBe('{{baseUrl}}/merchant/shipments');
    expect(create.request.header.map((h) => h.key)).toEqual([
      'Content-Type',
      'Idempotency-Key',
    ]);
    expect(JSON.parse(create.request.body!.raw)).toEqual({
      reference: 'ORD-1001',
      parcel: { size: 'small', weightKg: 0.1 },
    });

    const list = shipments.item.find(
      (i) => i.name === 'GET /merchant/shipments',
    )!;
    expect(list.request.url.raw).toBe('{{baseUrl}}/merchant/shipments?status=');
    expect(list.request.url.query).toEqual([
      { key: 'limit', value: '', disabled: true },
      { key: 'status', value: '', disabled: false },
    ]);

    const get = shipments.item.find((i) => i.name === 'Get a shipment')!;
    expect(get.request.url.path).toEqual(['merchant', 'shipments', ':id']);
    expect(get.request.url.variable).toEqual([{ key: 'id', value: '' }]);
    expect(get.request.auth).toBeUndefined();
  });

  it('sends no key on routes without a security requirement', () => {
    const download = collection.item.find((f) => f.name === 'Reports')!.item[0];
    expect(download.request.auth).toEqual({ type: 'noauth' });
  });

  it('stops on self-referencing schemas', () => {
    const loop = {
      components: { schemas: { Node: { $ref: '#/components/schemas/Node' } } },
    } as unknown as OpenAPIObject;
    expect(
      exampleOf(loop, { $ref: '#/components/schemas/Node' }, 0),
    ).toBeNull();
  });
});
