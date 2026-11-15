import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type {
  InvoiceTotals,
  StatementEntry,
  StatementTotals,
} from '../domain/statement';

export interface PartyDetails {
  name: string;
  lines: string[];
}

export interface StatementDocument {
  title: string;
  merchant: PartyDetails;
  month: string;
  mode: 'test' | 'live';
  toDate: boolean;
  totals: StatementTotals;
  entries: StatementEntry[];
  truncatedAt: number | null;
  generatedAt: Date;
}

export interface ManifestDocument {
  reference: string;
  merchantName: string;
  mode: 'test' | 'live';
  hub: PartyDetails;
  expectedDropAt: Date | null;
  shipments: {
    trackingCode: string;
    reference: string;
    destination: string;
  }[];
  generatedAt: Date;
}

export interface InvoiceDocument {
  number: string;
  month: string;
  issuedAt: Date;
  seller: PartyDetails;
  buyer: PartyDetails;
  totals: InvoiceTotals;
  vatEnabled: boolean;
}

const MARGIN = 50;

// The built-in PDF fonts have no ₦ glyph (or Unicode minus), so amounts
// print as "NGN 1,075.00" / "-NGN 25.00".
// YYYY-MM-DD in Lagos (UTC+1), matching the month boundaries.
function lagosDate(instant: Date): string {
  return new Date(instant.getTime() + 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function money(kobo: number): string {
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / 100).toLocaleString('en-US');
  return `${kobo < 0 ? '-' : ''}NGN ${naira}.${String(abs % 100).padStart(2, '0')}`;
}

// Statement and tax invoice PDFs (A4 portrait, pdfkit).
@Injectable()
export class DocumentRenderer {
  statementPdf(doc: StatementDocument): Promise<Buffer> {
    return this.render((pdf) => {
      this.header(
        pdf,
        doc.title,
        `${doc.month}${doc.toDate ? ' (to date)' : ''}`,
      );
      if (doc.mode === 'test') {
        pdf.fillColor('#B00020').fontSize(10).text('TEST MODE: not real money');
        pdf.fillColor('#000000').moveDown(0.5);
      }
      this.party(pdf, 'Account', doc.merchant);
      pdf.moveDown();
      const t = doc.totals;
      this.keyValues(pdf, [
        ['Opening balance', money(t.openingKobo)],
        ['Money in', money(t.creditsKobo)],
        ['Money out', money(t.debitsKobo)],
        ['Closing balance', money(t.closingKobo)],
      ]);
      pdf.moveDown();
      this.table(
        pdf,
        ['Date', 'Description', 'Amount', 'Balance'],
        [70, 255, 85, 85],
        doc.entries.map((e) => [
          lagosDate(e.at),
          [e.description, e.reference ?? e.trackingCode]
            .filter(Boolean)
            .join(' · '),
          money(e.amountKobo),
          money(e.balanceAfterKobo),
        ]),
      );
      if (doc.truncatedAt !== null) {
        pdf
          .moveDown()
          .font('Helvetica')
          .fontSize(9)
          .fillColor('#555555')
          .text(
            `Showing the first ${doc.truncatedAt} lines. Download the CSV for all of them.`,
          );
      }
      this.footer(pdf, `Generated ${doc.generatedAt.toISOString()}`);
    });
  }

  invoicePdf(doc: InvoiceDocument): Promise<Buffer> {
    return this.render((pdf) => {
      this.header(pdf, 'Tax invoice', doc.number);
      this.keyValues(pdf, [
        ['Invoice number', doc.number],
        ['Period', doc.month],
        ['Issued', lagosDate(doc.issuedAt)],
      ]);
      pdf.moveDown();
      this.party(pdf, 'From', doc.seller);
      pdf.moveDown(0.5);
      this.party(pdf, 'Billed to', doc.buyer);
      pdf.moveDown();
      this.table(
        pdf,
        ['Description', 'Qty', 'Amount'],
        [330, 60, 105],
        doc.totals.lines.map((line) => [
          line.description,
          String(line.quantity),
          money(line.amountKobo),
        ]),
      );
      pdf.moveDown();
      this.keyValues(
        pdf,
        doc.vatEnabled
          ? [
              ['Amount before VAT', money(doc.totals.netKobo)],
              ['VAT (7.5%, included)', money(doc.totals.vatKobo)],
              ['Total', money(doc.totals.totalKobo)],
            ]
          : [['Total', money(doc.totals.totalKobo)]],
      );
      pdf.moveDown();
      pdf
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#555555')
        .text(
          doc.vatEnabled
            ? 'Prices include VAT. Paid from your prepaid Locoomo wallet.'
            : 'VAT is not charged on these services. Paid from your prepaid Locoomo wallet.',
        );
      this.footer(pdf, `${doc.number}`);
    });
  }

  // For the driver: the hub scans the QR (the manifest reference) first,
  // then each parcel.
  async manifestPdf(doc: ManifestDocument): Promise<Buffer> {
    const qr = await QRCode.toBuffer(doc.reference, {
      margin: 0,
      width: 300,
      errorCorrectionLevel: 'M',
    });
    return this.render((pdf) => {
      this.header(pdf, 'Manifest', doc.merchantName);
      if (doc.mode === 'test') {
        pdf
          .fillColor('#B00020')
          .fontSize(10)
          .text('TEST MODE: not for shipping');
        pdf.fillColor('#000000').moveDown(0.5);
      }
      const top = pdf.y;
      pdf.image(qr, pdf.page.width - MARGIN - 110, top, { width: 110 });
      pdf.font('Helvetica-Bold').fontSize(22).text(doc.reference, MARGIN, top, {
        width: 330,
      });
      pdf.moveDown(0.5);
      this.party(pdf, 'Deliver to hub', doc.hub);
      pdf.moveDown(0.5);
      this.keyValues(pdf, [
        ['Parcels', String(doc.shipments.length)],
        [
          'Expected',
          doc.expectedDropAt
            ? `${lagosDate(doc.expectedDropAt)} ${new Date(doc.expectedDropAt.getTime() + 3_600_000).toISOString().slice(11, 16)}`
            : '-',
        ],
      ]);
      pdf.y = Math.max(pdf.y, top + 125);
      pdf.moveDown();
      this.table(
        pdf,
        ['#', 'Tracking code', 'Your reference', 'Destination'],
        [35, 130, 150, 180],
        doc.shipments.map((s, i) => [
          String(i + 1),
          s.trackingCode,
          s.reference,
          s.destination,
        ]),
        [],
      );
      this.footer(
        pdf,
        `${doc.reference} · generated ${doc.generatedAt.toISOString()}`,
      );
    });
  }

  private async render(
    draw: (pdf: PDFKit.PDFDocument) => void,
  ): Promise<Buffer> {
    const pdf = new PDFDocument({ size: 'A4', margin: MARGIN });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve, reject) => {
      pdf.on('end', () => resolve(Buffer.concat(chunks)));
      pdf.on('error', reject);
    });
    draw(pdf);
    pdf.end();
    return done;
  }

  private header(
    pdf: PDFKit.PDFDocument,
    title: string,
    subtitle: string,
  ): void {
    pdf
      .font('Helvetica-Bold')
      .fontSize(18)
      .fillColor('#000000')
      .text('LOCOOMO');
    pdf.font('Helvetica-Bold').fontSize(14).text(title);
    pdf.font('Helvetica').fontSize(10).fillColor('#555555').text(subtitle);
    pdf.fillColor('#000000').moveDown();
  }

  private party(
    pdf: PDFKit.PDFDocument,
    label: string,
    party: PartyDetails,
  ): void {
    pdf
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#555555')
      .text(label.toUpperCase());
    pdf
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('#000000')
      .text(party.name);
    pdf.font('Helvetica').fontSize(9);
    for (const line of party.lines) {
      pdf.text(line);
    }
  }

  private keyValues(pdf: PDFKit.PDFDocument, rows: [string, string][]): void {
    for (const [key, value] of rows) {
      const y = pdf.y;
      pdf.font('Helvetica').fontSize(10).text(key, MARGIN, y, { width: 250 });
      pdf.font('Helvetica-Bold').text(value, MARGIN + 250, y, {
        width: 245,
        align: 'right',
      });
    }
    pdf.x = MARGIN;
  }

  private table(
    pdf: PDFKit.PDFDocument,
    headings: string[],
    widths: number[],
    rows: string[][],
    // Amount columns: the last two by default.
    rightAligned: number[] = [headings.length - 2, headings.length - 1],
  ): void {
    const drawRow = (cells: string[], bold: boolean): void => {
      if (pdf.y > pdf.page.height - 90) {
        pdf.addPage();
      }
      const y = pdf.y;
      let x = MARGIN;
      let height = 0;
      cells.forEach((cell, i) => {
        pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
        const align = i > 0 && rightAligned.includes(i) ? 'right' : 'left';
        pdf.text(cell, x, y, { width: widths[i] - 6, align });
        height = Math.max(height, pdf.y - y);
        x += widths[i];
      });
      pdf.y = y + height + 3;
    };
    drawRow(headings, true);
    pdf
      .moveTo(MARGIN, pdf.y)
      .lineTo(MARGIN + widths.reduce((a, b) => a + b, 0), pdf.y)
      .strokeColor('#999999')
      .stroke();
    pdf.y += 3;
    for (const row of rows) {
      drawRow(row, false);
    }
    pdf.x = MARGIN;
  }

  private footer(pdf: PDFKit.PDFDocument, text: string): void {
    pdf
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#999999')
      .text(text, MARGIN, pdf.page.height - 40, { lineBreak: false });
  }
}
