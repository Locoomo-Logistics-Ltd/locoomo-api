import type { OpenAPIObject } from '@nestjs/swagger';

// Postman Collection v2.1, generated from the merchant OpenAPI document
// (plan §12, M7c) so the two never drift. Folders follow the OpenAPI tags;
// `{{baseUrl}}` and `{{secretKey}}` are collection variables the
// integrator fills in once.

const SCHEMA_URL =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
// Every merchant path starts with this; it becomes part of {{baseUrl}}.
const API_PREFIX = '/api/v1';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type Json = Record<string, unknown>;

export interface PostmanCollection {
  info: { name: string; description: string; schema: string };
  auth: {
    type: 'bearer';
    bearer: { key: string; value: string; type: string }[];
  };
  variable: { key: string; value: string }[];
  item: { name: string; item: PostmanRequestItem[] }[];
}

export interface PostmanRequestItem {
  name: string;
  request: {
    method: string;
    description?: string;
    header: { key: string; value: string; description?: string }[];
    url: {
      raw: string;
      host: string[];
      path: string[];
      query?: {
        key: string;
        value: string;
        disabled: boolean;
        description?: string;
      }[];
      variable?: { key: string; value: string }[];
    };
    body?: { mode: 'raw'; raw: string; options: { raw: { language: 'json' } } };
    auth?: { type: 'noauth' };
  };
}

export function toPostmanCollection(
  document: OpenAPIObject,
  baseUrl: string,
): PostmanCollection {
  const folders = new Map<string, PostmanRequestItem[]>();
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = (operations as Json)[method] as Json | undefined;
      if (!operation) {
        continue;
      }
      const tag = ((operation.tags as string[] | undefined) ?? ['Other'])[0];
      const item = requestItem(document, path, method, operation);
      folders.set(tag, [...(folders.get(tag) ?? []), item]);
    }
  }
  return {
    info: {
      name: document.info.title,
      description: document.info.description ?? '',
      schema: SCHEMA_URL,
    },
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{secretKey}}', type: 'string' }],
    },
    variable: [
      { key: 'baseUrl', value: `${baseUrl.replace(/\/+$/, '')}${API_PREFIX}` },
      { key: 'secretKey', value: 'sk_test_…' },
    ],
    item: [...folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, item]) => ({ name, item })),
  };
}

function requestItem(
  document: OpenAPIObject,
  path: string,
  method: string,
  operation: Json,
): PostmanRequestItem {
  const relative = path.startsWith(API_PREFIX)
    ? path.slice(API_PREFIX.length)
    : path;
  const segments = relative
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/^\{(.+)\}$/, ':$1'));
  const parameters = (operation.parameters as Json[] | undefined) ?? [];
  const query = parameters
    .filter((p) => p.in === 'query')
    .map((p) => ({
      key: p.name as string,
      value: '',
      // Optional filters start switched off.
      disabled: p.required !== true,
      ...(typeof p.description === 'string' && { description: p.description }),
    }));
  const variable = parameters
    .filter((p) => p.in === 'path')
    .map((p) => ({ key: p.name as string, value: '' }));
  const header: PostmanRequestItem['request']['header'] = [];
  const schema = jsonBodySchema(operation);
  if (schema) {
    header.push({ key: 'Content-Type', value: 'application/json' });
  }
  if (method === 'post') {
    header.push({
      key: 'Idempotency-Key',
      value: '{{$guid}}',
      description: 'Reuse the same key when you retry this request.',
    });
  }
  const queryString = query
    .filter((q) => !q.disabled)
    .map((q) => `${q.key}=`)
    .join('&');
  const url: PostmanRequestItem['request']['url'] = {
    raw: `{{baseUrl}}/${segments.join('/')}${queryString ? `?${queryString}` : ''}`,
    host: ['{{baseUrl}}'],
    path: segments,
    ...(query.length > 0 && { query }),
    ...(variable.length > 0 && { variable }),
  };
  const name = requestName(
    (operation.summary as string | undefined) ??
      (operation.description as string | undefined),
  );
  return {
    name: name || `${method.toUpperCase()} ${relative}`,
    request: {
      method: method.toUpperCase(),
      ...(typeof operation.description === 'string' && {
        description: operation.description,
      }),
      header,
      url,
      ...(schema && {
        body: {
          mode: 'raw' as const,
          raw: JSON.stringify(exampleOf(document, schema, 0), null, 2),
          options: { raw: { language: 'json' as const } },
        },
      }),
      // Controllers with @ApiBearerAuth carry a security entry; routes
      // without one (signed download links) take no key.
      ...(operation.security === undefined && {
        auth: { type: 'noauth' as const },
      }),
    },
  };
}

// The doc comment's first sentence, without "(MERCHANT_API.md §…)" refs.
function requestName(text: string | undefined): string {
  const flat = (text ?? '')
    .replace(/\s*\((?:see )?[A-Z_]+\.md[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const first = flat.length > 80 ? flat.split(/(?<=[.:])\s/)[0] : flat;
  return first.replace(/[.:]$/, '');
}

function jsonBodySchema(operation: Json): Json | undefined {
  const body = operation.requestBody as Json | undefined;
  const content = body?.content as Json | undefined;
  const json = content?.['application/json'] as Json | undefined;
  return json?.schema as Json | undefined;
}

// A plausible example body: declared examples and defaults first, then
// the first enum value, then a placeholder by type. Only required
// properties are filled, so the body is a minimal valid starting point.
export function exampleOf(
  document: OpenAPIObject,
  schema: Json,
  depth: number,
): unknown {
  if (depth > 6) {
    return null;
  }
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = document.components?.schemas?.[name] as Json | undefined;
    return target ? exampleOf(document, target, depth + 1) : {};
  }
  if (schema.example !== undefined) {
    return schema.example;
  }
  if (schema.default !== undefined) {
    return schema.default;
  }
  const allOf = (schema.allOf ?? schema.oneOf ?? schema.anyOf) as
    Json[] | undefined;
  if (allOf?.length) {
    return exampleOf(document, allOf[0], depth + 1);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  switch (schema.type) {
    case 'object': {
      const properties = (schema.properties as Json | undefined) ?? {};
      const required = new Set((schema.required as string[] | undefined) ?? []);
      return Object.fromEntries(
        Object.entries(properties)
          .filter(([key]) => required.has(key))
          .map(([key, value]) => [
            key,
            exampleOf(document, value as Json, depth + 1),
          ]),
      );
    }
    case 'array':
      return schema.items
        ? [exampleOf(document, schema.items as Json, depth + 1)]
        : [];
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return false;
    case 'string':
      if (schema.format === 'uuid') {
        return '00000000-0000-4000-8000-000000000000';
      }
      if (schema.format === 'date-time') {
        return '2026-01-01T00:00:00.000Z';
      }
      if (schema.format === 'email') {
        return 'buyer@example.com';
      }
      return '';
    default:
      // A property with no declared shape (e.g. a free-form object).
      return schema.properties
        ? exampleOf(document, { ...schema, type: 'object' }, depth)
        : {};
  }
}
