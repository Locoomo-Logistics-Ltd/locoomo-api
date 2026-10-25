// An attachment travels through the outbox as JSON, so its bytes are
// base64. `contentId` makes it an inline image the HTML can show with
// <img src="cid:{contentId}"> — how emails embed the tracking QR code
// (data: URIs are stripped by Gmail and most other clients).
export interface EmailAttachment {
  filename: string;
  contentBase64: string;
  contentType: string;
  contentId?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
}
