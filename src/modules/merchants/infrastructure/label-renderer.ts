import { Injectable } from '@nestjs/common';
import bwipjs from 'bwip-js';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type { LabelContent, LabelFormat } from '../domain/label';

const MM = 72 / 25.4;
// A6 portrait, the label size; A4 holds four of them (2 × 2).
const A6 = { width: 105 * MM, height: 148 * MM };
const A4 = { width: 210 * MM, height: 297 * MM };
const MARGIN = 6 * MM;

// Lays labels out as a PDF (pdfkit). Barcodes are Code 128 (bwip-js) and
// QR (qrcode), both encoding the tracking code.
@Injectable()
export class LabelRenderer {
  async render(labels: LabelContent[], format: LabelFormat): Promise<Buffer> {
    const page = format === 'a4' ? A4 : A6;
    const doc = new PDFDocument({
      size: [page.width, page.height],
      margin: 0,
      autoFirstPage: false,
      info: { Title: 'Locoomo shipping labels', Producer: 'Locoomo' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const perPage = format === 'a4' ? 4 : 1;
    for (let i = 0; i < labels.length; i++) {
      const slot = i % perPage;
      if (slot === 0) {
        doc.addPage();
      }
      const x = format === 'a4' ? (slot % 2) * A6.width : 0;
      const y = format === 'a4' ? Math.floor(slot / 2) * A6.height : 0;
      await this.drawLabel(doc, labels[i], x, y);
    }
    doc.end();
    return done;
  }

  private async drawLabel(
    doc: PDFKit.PDFDocument,
    label: LabelContent,
    x: number,
    y: number,
  ): Promise<void> {
    const width = A6.width - 2 * MARGIN;
    let cursor = y + MARGIN;
    const left = x + MARGIN;

    // Cut guide.
    doc
      .save()
      .lineWidth(0.5)
      .dash(3, { space: 3 })
      .strokeColor('#999999')
      .rect(x + 1, y + 1, A6.width - 2, A6.height - 2)
      .stroke()
      .restore();

    doc.font('Helvetica-Bold').fontSize(14).fillColor('#000000');
    doc.text('LOCOOMO', left, cursor, { width, continued: false });
    if (label.test) {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#B00020')
        .text('TEST LABEL · NOT FOR SHIPPING', left, cursor + 3, {
          width,
          align: 'right',
        })
        .fillColor('#000000');
    }
    cursor += 22;

    doc
      .font('Courier-Bold')
      .fontSize(22)
      .text(label.trackingCode, left, cursor, {
        width,
        align: 'center',
      });
    cursor += 28;

    const barcode = await bwipjs.toBuffer({
      bcid: 'code128',
      text: label.scanValue,
      scale: 3,
      height: 14,
      includetext: false,
    });
    doc.image(barcode, left, cursor, { width, height: 48 });
    cursor += 56;

    const qrSize = 70;
    const qr = await QRCode.toBuffer(label.scanValue, {
      margin: 0,
      width: 280,
      errorCorrectionLevel: 'M',
    });
    doc.image(qr, left + width - qrSize, cursor, {
      width: qrSize,
      height: qrSize,
    });
    const textWidth = width - qrSize - 8;
    doc.font('Helvetica').fontSize(8).fillColor('#555555');
    doc.text('DELIVER TO NODE', left, cursor, { width: textWidth });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#000000');
    doc.text(label.toNode, left, cursor + 10, { width: textWidth });
    doc.font('Helvetica').fontSize(9);
    doc.text(label.toAddress, left, doc.y + 2, { width: textWidth });
    cursor = Math.max(doc.y, cursor + qrSize) + 8;

    const row = (title: string, value: string): void => {
      doc.font('Helvetica').fontSize(8).fillColor('#555555');
      doc.text(title, left, cursor, { width });
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000');
      doc.text(value, left, cursor + 9, { width });
      cursor = doc.y + 5;
    };
    row('FOR', label.receiver);
    row('FROM', label.from);
    if (label.dropOffAt) {
      row('DROP OFF AT', label.dropOffAt);
    }
    row('REFERENCE', label.reference);

    doc.font('Helvetica').fontSize(8).fillColor('#555555');
    doc.text(label.details, left, cursor, { width });
    cursor = doc.y + 4;

    if (label.handling.length > 0) {
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#B00020');
      doc.text(label.handling.join('  ·  '), left, cursor, {
        width,
        align: 'center',
      });
      doc.fillColor('#000000');
    }
  }
}
