import { TrackingEmailService } from './tracking-email.service';
import { TrackingLinkService } from './tracking-link.service';

describe('TrackingEmailService', () => {
  const linkService = {
    urlFor: (code: string) => `https://app.test/track/${code}?t=tok`,
  } as unknown as TrackingLinkService;
  const service = new TrackingEmailService(linkService);

  it('puts the tracking code first, links the tracking page, and embeds a QR as a cid image', async () => {
    const block = await service.trackingBlock('LCM-4F2K-9XPT');

    expect(block.text.startsWith('Tracking code: LCM-4F2K-9XPT')).toBe(true);
    expect(block.text).toContain('https://app.test/track/LCM-4F2K-9XPT?t=tok');
    expect(block.html).toContain('src="cid:tracking-qr"');
    expect(block.attachments).toHaveLength(1);
    const [qr] = block.attachments;
    expect(qr.contentId).toBe('tracking-qr');
    expect(qr.contentType).toBe('image/png');
    // PNG signature.
    expect(
      Buffer.from(qr.contentBase64, 'base64').subarray(1, 4).toString(),
    ).toBe('PNG');
  });

  it('escapes the destination name in the label block', () => {
    const block = service.labelBlock('LCM-4F2K-9XPT', 'Lekki <b>Node</b>');
    expect(block.text).toContain('TO: LEKKI <B>NODE</B>');
    expect(block.html).toContain('TO: LEKKI &lt;B&gt;NODE&lt;/B&gt;');
  });
});
