// Cross-module entry point for the email shapes — modules that compose
// their own emails (tracking's QR block) need the types, but the module
// boundary rule keeps them out of notifications' domain/.
export type { EmailAttachment, EmailMessage } from '../domain/email-message';
