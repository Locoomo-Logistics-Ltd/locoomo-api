// Monthly statements and tax invoices (plan §8.3, M4e2). Months are Lagos
// calendar months (UTC+1, no daylight saving).

import { VAT_RATE } from './merchant-quote';
import { WalletEntryType } from './wallet';

export type DocumentFormat = 'pdf' | 'csv';

// The most lines a statement PDF lists (the CSV always has all of them).
export const PDF_STATEMENT_LINE_LIMIT = 500;

export interface MonthRange {
  month: string; // YYYY-MM
  start: Date; // inclusive
  end: Date; // exclusive
}

export function parseMonth(value: string): MonthRange | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2020 || year > 2100) {
    return null;
  }
  const next =
    month === 12
      ? `${year + 1}-01`
      : `${year}-${String(month + 1).padStart(2, '0')}`;
  return {
    month: value,
    start: new Date(`${value}-01T00:00:00+01:00`),
    end: new Date(`${next}-01T00:00:00+01:00`),
  };
}

// The Lagos month `instant` falls in, as YYYY-MM.
export function lagosMonth(instant: Date): string {
  return new Date(instant.getTime() + 60 * 60 * 1000).toISOString().slice(0, 7);
}

// LCM-INV-202611-ABCD1234: stable for a merchant and month.
export function invoiceNumber(month: string, merchantId: string): string {
  return `LCM-INV-${month.replace('-', '')}-${merchantId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export interface StatementEntry {
  at: Date;
  type: string;
  description: string;
  amountKobo: number;
  balanceAfterKobo: number;
  reference: string | null;
  trackingCode: string | null;
}

export interface StatementTotals {
  openingKobo: number;
  closingKobo: number;
  creditsKobo: number;
  debitsKobo: number;
  byType: Record<string, number>;
}

export function statementTotals(
  openingKobo: number,
  entries: StatementEntry[],
): StatementTotals {
  const byType: Record<string, number> = {};
  let credits = 0;
  let debits = 0;
  for (const entry of entries) {
    byType[entry.type] = (byType[entry.type] ?? 0) + entry.amountKobo;
    if (entry.amountKobo >= 0) {
      credits += entry.amountKobo;
    } else {
      debits += entry.amountKobo;
    }
  }
  // From sums, not the last line's balanceAfter: the ledger always sums to
  // the balance, and lines written in the same millisecond have no
  // reliable order.
  return {
    openingKobo,
    closingKobo: openingKobo + credits + debits,
    creditsKobo: credits,
    debitsKobo: debits,
    byType,
  };
}

// What a tax invoice bills: shipping services charged in the month.
export const INVOICED_TYPES: readonly string[] = [
  WalletEntryType.SHIPMENT_CHARGE,
  WalletEntryType.SHIPMENT_ADJUSTMENT,
];

export interface InvoiceLine {
  description: string;
  quantity: number;
  amountKobo: number; // VAT-inclusive
}

export interface InvoiceTotals {
  lines: InvoiceLine[];
  totalKobo: number;
  vatKobo: number; // included in totalKobo; 0 when VAT isn't charged
  netKobo: number;
}

// Charges are negative wallet movements; the invoice shows them as positive
// amounts billed. Re-pricing refunds reduce the total.
export function invoiceTotals(
  entries: {
    type: string;
    amountKobo: number;
    shipmentId: string | null;
  }[],
  vatEnabled: boolean,
): InvoiceTotals {
  const charges = entries.filter(
    (e) => e.type === (WalletEntryType.SHIPMENT_CHARGE as string),
  );
  const adjustments = entries.filter(
    (e) => e.type === (WalletEntryType.SHIPMENT_ADJUSTMENT as string),
  );
  const lines: InvoiceLine[] = [];
  if (charges.length > 0) {
    lines.push({
      description: 'Parcel delivery to Locoomo Nodes',
      quantity: new Set(charges.map((e) => e.shipmentId)).size,
      amountKobo: -charges.reduce((sum, e) => sum + e.amountKobo, 0),
    });
  }
  if (adjustments.length > 0) {
    lines.push({
      description: 'Re-pricing after measuring at drop-off',
      quantity: adjustments.length,
      amountKobo: -adjustments.reduce((sum, e) => sum + e.amountKobo, 0),
    });
  }
  const totalKobo = lines.reduce((sum, line) => sum + line.amountKobo, 0);
  const vatKobo = vatEnabled
    ? Math.round((totalKobo * VAT_RATE) / (1 + VAT_RATE))
    : 0;
  return { lines, totalKobo, vatKobo, netKobo: totalKobo - vatKobo };
}

// RFC 4180 CSV from rows of cells.
export function toCsv(rows: (string | number | null)[][]): string {
  const cell = (value: string | number | null): string => {
    const text = value === null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

// 2500050 → "25000.50" (CSV: plain naira, no symbol or separators).
export function nairaPlain(kobo: number): string {
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(kobo);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
