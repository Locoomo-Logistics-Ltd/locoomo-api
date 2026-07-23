// Injection token for the NotificationSender port — interfaces have no
// runtime value in TypeScript, so DI needs an explicit token to bind
// SmtpEmailSender (or any future adapter) against.
export const NOTIFICATION_SENDER = Symbol('NOTIFICATION_SENDER');
