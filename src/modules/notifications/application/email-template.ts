import { escapeHtml } from '../../../common/html/escape-html';

// One shared layout for every transactional email, so the ~dozen new
// merchant/onboarding emails (and existing ones as they're touched) look
// consistent and every one ships a plain-text part. Content is described as
// blocks, never raw HTML strings, so escaping can't be forgotten — the only
// way to inject markup is `rawHtml`, reserved for trusted, pre-escaped
// fragments such as TrackingEmailService's QR block.
export type EmailBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'details'; rows: Array<{ label: string; value: string }> }
  | { kind: 'button'; label: string; url: string }
  | { kind: 'code'; label: string; value: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'rawHtml'; html: string; text: string };

export interface EmailTemplateInput {
  // Optional greeting name ("Hi Ada,").
  greetingName?: string | null;
  // Bold heading at the top of the body.
  heading: string;
  blocks: EmailBlock[];
  // Small print under the body, e.g. why they got the email.
  footnote?: string;
}

const BRAND = 'Locoomo';

export function renderEmail(input: EmailTemplateInput): {
  html: string;
  text: string;
} {
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  if (input.greetingName) {
    htmlParts.push(p(`Hi ${escapeHtml(input.greetingName)},`));
    textParts.push(`Hi ${input.greetingName},`);
  }

  for (const block of input.blocks) {
    switch (block.kind) {
      case 'paragraph':
        htmlParts.push(p(escapeHtml(block.text)));
        textParts.push(block.text);
        break;
      case 'details':
        htmlParts.push(
          `<table role="presentation" style="border-collapse:collapse;margin:12px 0">` +
            block.rows
              .map(
                (row) =>
                  `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;vertical-align:top">${escapeHtml(row.label)}</td>` +
                  `<td style="padding:4px 0;color:#111827"><strong>${escapeHtml(row.value)}</strong></td></tr>`,
              )
              .join('') +
            `</table>`,
        );
        textParts.push(
          block.rows.map((r) => `${r.label}: ${r.value}`).join('\n'),
        );
        break;
      case 'button':
        htmlParts.push(
          `<p style="margin:20px 0"><a href="${escapeHtml(block.url)}" ` +
            `style="background:#111827;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">` +
            `${escapeHtml(block.label)}</a></p>`,
        );
        textParts.push(`${block.label}: ${block.url}`);
        break;
      case 'code':
        htmlParts.push(
          `<p style="margin:16px 0">${escapeHtml(block.label)}<br>` +
            `<span style="font-size:24px;letter-spacing:4px;font-family:monospace"><strong>${escapeHtml(block.value)}</strong></span></p>`,
        );
        textParts.push(`${block.label}: ${block.value}`);
        break;
      case 'list':
        htmlParts.push(
          `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`,
        );
        textParts.push(block.items.map((item) => `- ${item}`).join('\n'));
        break;
      case 'rawHtml':
        htmlParts.push(block.html);
        textParts.push(block.text);
        break;
    }
  }

  const footnoteHtml = input.footnote
    ? `<p style="color:#6b7280;font-size:12px;margin-top:24px">${escapeHtml(input.footnote)}</p>`
    : '';

  const html =
    `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6">` +
    `<div style="max-width:560px;margin:0 auto;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827">` +
    `<div style="font-weight:bold;font-size:18px;margin-bottom:16px">${BRAND}</div>` +
    `<div style="background:#ffffff;border-radius:8px;padding:24px">` +
    `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(input.heading)}</h1>` +
    htmlParts.join('') +
    footnoteHtml +
    `</div></div></body></html>`;

  const text =
    [input.heading, ...textParts, input.footnote ?? '']
      .filter((part) => part.length > 0)
      .join('\n\n') + `\n\n— ${BRAND}`;

  return { html, text };
}

function p(inner: string): string {
  return `<p style="margin:0 0 12px">${inner}</p>`;
}
