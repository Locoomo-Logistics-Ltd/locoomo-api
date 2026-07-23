export interface EmailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}
