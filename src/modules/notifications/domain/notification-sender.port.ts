import { EmailMessage } from './email-message';

export interface NotificationSender {
  sendEmail(message: EmailMessage): Promise<void>;
}
