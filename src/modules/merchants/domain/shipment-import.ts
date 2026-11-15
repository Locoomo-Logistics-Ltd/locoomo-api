// Shipment imports (MERCHANT_API.md §7.3): many shipments at once, from a
// JSON list or a CSV file, created in the background.

export const MAX_IMPORT_ROWS = 10_000;
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
// Imports a merchant may have waiting or running at once.
export const MAX_ACTIVE_IMPORTS = 3;

export type ImportStatus = 'queued' | 'processing' | 'done' | 'failed';
export type ImportRowStatus = 'pending' | 'created' | 'failed';
export type ImportSource = 'json' | 'csv';

// CSV columns (case-insensitive; order doesn't matter). Anything else must
// start with `meta_`, which becomes a metadata key.
export const CSV_COLUMNS = [
  'reference',
  'destination_node_id',
  'origin_node_id',
  'receiver_name',
  'receiver_phone',
  'receiver_email',
  'description',
  'size',
  'weight_kg',
  'length_cm',
  'width_cm',
  'height_cm',
  'handling',
  'declared_value_ngn',
  'external_barcode',
  'notify_receiver',
] as const;
const REQUIRED_COLUMNS = [
  'reference',
  'destination_node_id',
  'receiver_name',
  'receiver_phone',
  'description',
  'size',
] as const;

export const CSV_TEMPLATE =
  [
    [...CSV_COLUMNS, 'meta_order_id'].join(','),
    [
      'ORD-1001-1',
      '8b0e2f4a-0000-4000-8000-000000000000',
      '7a1d9e42-0000-4000-8000-000000000000',
      'Chioma Okafor',
      '08031234567',
      'chioma@example.com',
      'Wireless earbuds',
      'small',
      '0.4',
      '15',
      '10',
      '6',
      'fragile',
      '25000',
      '',
      'locoomo',
      '1001',
    ].join(','),
  ].join('\r\n') + '\r\n';

export class CsvFormatError extends Error {}

// RFC 4180: comma-separated, fields optionally in double quotes ("" inside
// quotes is a quote; quoted fields may hold commas and newlines), CRLF or
// LF line ends, an optional UTF-8 BOM (Excel). Blank lines are skipped.
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    if (row.some((value) => value.trim() !== '')) {
      rows.push(row);
    }
    row = [];
  };
  while (i < input.length) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\n' || char === '\r') {
      endRow();
      if (char === '\r' && input[i + 1] === '\n') {
        i++;
      }
    } else {
      field += char;
    }
    i++;
  }
  if (quoted) {
    throw new CsvFormatError('A quoted field is never closed');
  }
  if (field !== '' || row.length > 0) {
    endRow();
  }
  return rows;
}

const blankToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.trim();

// Numbers stay strings when they don't parse, so validation reports them
// against the right field instead of silently dropping them.
const numeric = (value: string | undefined): number | string | undefined => {
  const raw = blankToUndefined(value);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : raw;
};

export interface CsvRows {
  // Shipment-shaped objects (POST /shipments body), one per data row.
  items: Record<string, unknown>[];
  // The CSV line each item came from (1 = header), for error messages.
  lines: number[];
}

// Header + data rows → shipment bodies. Column problems are file errors;
// value problems are left to per-row validation.
export function csvToShipments(rows: string[][]): CsvRows {
  if (rows.length === 0) {
    throw new CsvFormatError('The file is empty');
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const known = new Set<string>(CSV_COLUMNS);
  const unknown = header.filter((h) => !known.has(h) && !h.startsWith('meta_'));
  if (unknown.length > 0) {
    throw new CsvFormatError(`Unknown columns: ${unknown.join(', ')}`);
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new CsvFormatError(`Missing columns: ${missing.join(', ')}`);
  }
  const items: Record<string, unknown>[] = [];
  const lines: number[] = [];
  rows.slice(1).forEach((values, offset) => {
    const cell = (name: string): string | undefined => {
      const index = header.indexOf(name);
      return index < 0 ? undefined : values[index];
    };
    const metadata: Record<string, string> = {};
    header.forEach((name, index) => {
      const value = blankToUndefined(values[index]);
      if (name.startsWith('meta_') && value !== undefined) {
        metadata[name.slice('meta_'.length)] = value;
      }
    });
    const declaredNgn = numeric(cell('declared_value_ngn'));
    const originNodeId = blankToUndefined(cell('origin_node_id'));
    const handling = blankToUndefined(cell('handling'));
    const parcel: Record<string, unknown> = {
      description: blankToUndefined(cell('description')),
      size: blankToUndefined(cell('size'))?.toLowerCase(),
      weightKg: numeric(cell('weight_kg')),
      lengthCm: numeric(cell('length_cm')),
      widthCm: numeric(cell('width_cm')),
      heightCm: numeric(cell('height_cm')),
      handling: handling
        ? handling.split(/[;|]/).map((h) => h.trim().toLowerCase())
        : undefined,
      declaredValueKobo:
        typeof declaredNgn === 'number'
          ? Math.round(declaredNgn * 100)
          : declaredNgn,
    };
    const item: Record<string, unknown> = {
      reference: blankToUndefined(cell('reference')),
      destinationNodeId: blankToUndefined(cell('destination_node_id')),
      ...(originNodeId && { origin: { type: 'node', nodeId: originNodeId } }),
      receiver: {
        name: blankToUndefined(cell('receiver_name')),
        phone: blankToUndefined(cell('receiver_phone')),
        email: blankToUndefined(cell('receiver_email')),
      },
      parcel,
      externalBarcode: blankToUndefined(cell('external_barcode')),
      notifyReceiver: blankToUndefined(cell('notify_receiver'))?.toLowerCase(),
      ...(Object.keys(metadata).length > 0 && { metadata }),
    };
    items.push(dropUndefined(item));
    lines.push(offset + 2);
  });
  return { items, lines };
}

// Absent values must be absent (the validator forbids unknown keys and
// rejects explicit undefined only for some decorators).
function dropUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    out[key] =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? dropUndefined(entry as Record<string, unknown>)
        : entry;
  }
  return out;
}
