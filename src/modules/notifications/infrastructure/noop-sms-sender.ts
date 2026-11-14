import { Logger } from '@nestjs/common';
import type { SmsMessage, SmsSendResult, SmsSender } from '../domain/sms';

// Bound when SMS_PROVIDER=none or no SMS_API_KEY is set. Never throws, never
// sends — every flow falls back to its other channels.
export class NoopSmsSender implements SmsSender {
  private readonly logger = new Logger(NoopSmsSender.name);

  constructor(private readonly reason: string) {
    this.logger.log(`SMS disabled: ${reason}. SMS sends will be skipped.`);
  }

  isEnabled(): boolean {
    return false;
  }

  send(message: SmsMessage): Promise<SmsSendResult> {
    this.logger.debug(
      `Skipped SMS${message.tag ? ` (${message.tag})` : ''}: ${this.reason}`,
    );
    return Promise.resolve({ status: 'skipped', reason: this.reason });
  }
}
