import { Injectable } from '@nestjs/common';
import { toBuffer } from 'qrcode';
import { escapeHtml } from '../../../common/html/escape-html';
import type { EmailAttachment } from '../../notifications/application/email-types';
import { labelInstructionsFor } from './label-instructions';
import { TrackingLinkService } from './tracking-link.service';

const QR_CONTENT_ID = 'tracking-qr';

export interface EmailBlock {
  text: string;
  html: string;
  attachments: EmailAttachment[];
}

// Reusable pieces for any email about a parcel, so every one of them shows
// the tracking code, link and QR the same way.
@Injectable()
export class TrackingEmailService {
  constructor(private readonly trackingLinkService: TrackingLinkService) {}

  // Tracking code (first, and on its own — tests and humans both look for
  // it there), a QR of it to show at a Node counter, and the public tracking
  // link. The QR encodes only the tracking code: whoever scans it at a
  // counter gets nothing they couldn't read off the parcel anyway.
  async trackingBlock(trackingCode: string): Promise<EmailBlock> {
    const url = this.trackingLinkService.urlFor(trackingCode);
    const qr = await toBuffer(trackingCode, {
      type: 'png',
      width: 240,
      margin: 1,
      errorCorrectionLevel: 'M',
    });

    return {
      text:
        `Tracking code: ${trackingCode}\n` +
        `Track this parcel: ${url}\n` +
        'Show this code (or the QR code in this email) at the station counter.',
      html:
        `<p>Tracking code: <strong style="font-size:20px;letter-spacing:2px">${trackingCode}</strong></p>` +
        `<p><img src="cid:${QR_CONTENT_ID}" width="160" height="160" alt="QR code for ${trackingCode}"></p>` +
        `<p>Show this code at the station counter. <a href="${escapeHtml(url)}">Track this parcel</a></p>`,
      attachments: [
        {
          filename: `${trackingCode}.png`,
          contentBase64: qr.toString('base64'),
          contentType: 'image/png',
          contentId: QR_CONTENT_ID,
        },
      ],
    };
  }

  labelBlock(
    trackingCode: string,
    destinationNodeName: string,
  ): Omit<EmailBlock, 'attachments'> {
    const { lines, note } = labelInstructionsFor(
      trackingCode,
      destinationNodeName,
    );
    return {
      text: `${note}\n${lines.map((line) => `    ${line}`).join('\n')}`,
      html:
        `<p>${note}</p>` +
        `<p style="font-family:monospace;font-size:18px;border:2px dashed #999;padding:8px;display:inline-block">` +
        `${lines.map(escapeHtml).join('<br>')}</p>`,
    };
  }
}
