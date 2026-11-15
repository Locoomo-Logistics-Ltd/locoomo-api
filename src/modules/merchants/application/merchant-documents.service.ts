import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import type { Env } from '../../../config/env.validation';
import type { ApiKeyMode } from '../domain/api-key';
import {
  InvalidStatementMonthException,
  InvoiceNotAvailableException,
} from '../domain/exceptions/merchant.exceptions';
import {
  DocumentFormat,
  INVOICED_TYPES,
  invoiceNumber,
  invoiceTotals,
  lagosMonth,
  MonthRange,
  nairaPlain,
  parseMonth,
  PDF_STATEMENT_LINE_LIMIT,
  StatementEntry,
  statementTotals,
  toCsv,
} from '../domain/statement';
import {
  DocumentRenderer,
  PartyDetails,
} from '../infrastructure/document-renderer';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';

export interface RenderedDocument {
  body: Buffer;
  contentType: string;
  filename: string;
}

interface EntryRow {
  createdAt: Date;
  type: string;
  description: string;
  amountKobo: string;
  balanceAfterKobo: string;
  shipmentId: string | null;
  reference: string | null;
  trackingCode: string | null;
}

// Monthly wallet statements and tax invoices (plan §8.3, M4e2). Both are
// built on request from the ledger, which never changes, so the same month
// always gives the same document.
@Injectable()
export class MerchantDocumentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<Env, true>,
    private readonly renderer: DocumentRenderer,
  ) {}

  async statement(
    merchantId: string,
    mode: ApiKeyMode,
    month: string,
    format: DocumentFormat,
    now = new Date(),
  ): Promise<RenderedDocument> {
    const range = this.range(month, now);
    const merchant = await this.merchant(merchantId);
    const [openingKobo, rows] = await Promise.all([
      this.balanceBefore(merchantId, mode, range.start),
      this.entries(merchantId, mode, range),
    ]);
    const entries: StatementEntry[] = rows.map((row) => ({
      at: row.createdAt,
      type: row.type,
      description: row.description,
      amountKobo: Number(row.amountKobo),
      balanceAfterKobo: Number(row.balanceAfterKobo),
      reference: row.reference,
      trackingCode: row.trackingCode,
    }));
    const totals = statementTotals(openingKobo, entries);
    const filename = `locoomo-statement-${month}${mode === 'test' ? '-test' : ''}`;

    if (format === 'csv') {
      const csv = toCsv([
        [
          'date',
          'type',
          'description',
          'reference',
          'tracking_code',
          'amount_ngn',
          'balance_after_ngn',
        ],
        [
          '',
          'opening_balance',
          'Opening balance',
          null,
          null,
          null,
          nairaPlain(openingKobo),
        ],
        ...entries.map((e) => [
          e.at.toISOString(),
          e.type,
          e.description,
          e.reference,
          e.trackingCode,
          nairaPlain(e.amountKobo),
          nairaPlain(e.balanceAfterKobo),
        ]),
        [
          '',
          'closing_balance',
          'Closing balance',
          null,
          null,
          null,
          nairaPlain(totals.closingKobo),
        ],
      ]);
      return {
        body: Buffer.from(csv, 'utf8'),
        contentType: 'text/csv; charset=utf-8',
        filename: `${filename}.csv`,
      };
    }

    const truncated = entries.length > PDF_STATEMENT_LINE_LIMIT;
    const body = await this.renderer.statementPdf({
      title: mode === 'test' ? 'Wallet statement (test)' : 'Wallet statement',
      merchant: this.party(merchant),
      month,
      mode,
      toDate: month === lagosMonth(now),
      totals,
      entries: truncated ? entries.slice(0, PDF_STATEMENT_LINE_LIMIT) : entries,
      truncatedAt: truncated ? PDF_STATEMENT_LINE_LIMIT : null,
      generatedAt: now,
    });
    return {
      body,
      contentType: 'application/pdf',
      filename: `${filename}.pdf`,
    };
  }

  // Live mode, finished months only: an invoice for a month still running
  // would change after it was issued.
  async invoice(
    merchantId: string,
    mode: ApiKeyMode,
    month: string,
    format: DocumentFormat,
    now = new Date(),
  ): Promise<RenderedDocument> {
    if (mode !== 'live') {
      throw new InvoiceNotAvailableException(
        'Tax invoices are issued for live mode only',
      );
    }
    const range = this.range(month, now);
    if (month >= lagosMonth(now)) {
      throw new InvoiceNotAvailableException(
        `The invoice for ${month} is available once the month has ended`,
      );
    }
    const merchant = await this.merchant(merchantId);
    const rows = await this.entries(merchantId, mode, range, INVOICED_TYPES);
    const vatEnabled = this.config.get('VAT_ENABLED', { infer: true });
    const totals = invoiceTotals(
      rows.map((row) => ({
        type: row.type,
        amountKobo: Number(row.amountKobo),
        shipmentId: row.shipmentId,
      })),
      vatEnabled,
    );
    const number = invoiceNumber(month, merchantId);

    if (format === 'csv') {
      const csv = toCsv([
        ['invoice_number', 'period', 'description', 'quantity', 'amount_ngn'],
        ...totals.lines.map((line) => [
          number,
          month,
          line.description,
          line.quantity,
          nairaPlain(line.amountKobo),
        ]),
        ...(vatEnabled
          ? [
              [
                number,
                month,
                'VAT included (7.5%)',
                null,
                nairaPlain(totals.vatKobo),
              ],
            ]
          : []),
        [number, month, 'Total', null, nairaPlain(totals.totalKobo)],
      ]);
      return {
        body: Buffer.from(csv, 'utf8'),
        contentType: 'text/csv; charset=utf-8',
        filename: `${number}.csv`,
      };
    }

    const body = await this.renderer.invoicePdf({
      number,
      month,
      // Issued on the last day of the period (Lagos), whenever downloaded.
      issuedAt: new Date(range.end.getTime() - 1),
      seller: this.seller(),
      buyer: this.party(merchant),
      totals,
      vatEnabled,
    });
    return { body, contentType: 'application/pdf', filename: `${number}.pdf` };
  }

  private range(month: string, now: Date): MonthRange {
    const range = parseMonth(month);
    if (!range || range.start > now) {
      throw new InvalidStatementMonthException(month);
    }
    return range;
  }

  private async merchant(merchantId: string): Promise<MerchantEntity> {
    const merchant = await this.dataSource
      .getRepository(MerchantEntity)
      .findOneBy({ id: merchantId });
    if (!merchant) {
      throw new EntityNotFoundException('Merchant', merchantId);
    }
    return merchant;
  }

  private async balanceBefore(
    merchantId: string,
    mode: ApiKeyMode,
    start: Date,
  ): Promise<number> {
    const rows: { total: string | null }[] = await this.dataSource.query(
      `SELECT SUM("amountKobo")::text AS total FROM wallet_entries
        WHERE "merchantId" = $1 AND mode = $2 AND "createdAt" < $3`,
      [merchantId, mode, start],
    );
    return Number(rows[0]?.total ?? 0);
  }

  private entries(
    merchantId: string,
    mode: ApiKeyMode,
    range: MonthRange,
    types?: readonly string[],
  ): Promise<EntryRow[]> {
    const params: unknown[] = [merchantId, mode, range.start, range.end];
    let typeFilter = '';
    if (types) {
      params.push(types);
      typeFilter = 'AND e.type = ANY($5)';
    }
    return this.dataSource.query(
      `SELECT e."createdAt", e.type, e.description,
              e."amountKobo"::text AS "amountKobo",
              e."balanceAfterKobo"::text AS "balanceAfterKobo",
              e."shipmentId", s.reference, s."trackingCode"
         FROM wallet_entries e
         LEFT JOIN merchant_shipments s ON s.id = e."shipmentId"
        WHERE e."merchantId" = $1 AND e.mode = $2
          AND e."createdAt" >= $3 AND e."createdAt" < $4 ${typeFilter}
        ORDER BY e."createdAt", e.id`,
      params,
    );
  }

  private party(merchant: MerchantEntity): PartyDetails {
    const name = merchant.legalName ?? merchant.tradingName;
    const lines = [
      merchant.legalName && merchant.legalName !== merchant.tradingName
        ? `Trading as ${merchant.tradingName}`
        : null,
      merchant.addressLine1,
      merchant.addressLine2,
      [merchant.city, merchant.state].filter(Boolean).join(', ') || null,
      merchant.cacNumber ? `RC/BN: ${merchant.cacNumber}` : null,
      merchant.contactEmail,
    ].filter((line): line is string => !!line);
    return { name, lines };
  }

  private seller(): PartyDetails {
    const address = this.config.get('INVOICE_SELLER_ADDRESS', { infer: true });
    const tin = this.config.get('INVOICE_SELLER_TIN', { infer: true });
    return {
      name:
        this.config.get('INVOICE_SELLER_NAME', { infer: true }) ?? 'Locoomo',
      lines: [
        ...(address ? address.split('|').map((part) => part.trim()) : []),
        ...(tin ? [`TIN: ${tin}`] : []),
      ],
    };
  }
}
