import { Logger } from '@nestjs/common';
import { fetchWithPolicy } from '../../../common/http/fetch-with-policy';
import type { SmsMessage, SmsSendResult, SmsSender } from '../domain/sms';

export interface TermiiConfig {
  apiKey: string;
  baseUrl: string;
  senderId: string;
  channel: 'generic' | 'dnd';
}

interface TermiiSendResponse {
  message_id?: string;
  message?: string;
}

// Termii (https://developers.termii.com) — POST /api/sms/send.
//
// Failure handling follows plan D10 (SMS must never block a flow):
//  - 401/403 → our key is wrong or revoked. Log once, disable SMS for this
//    process (every later send is skipped immediately), return skipped.
//  - other 4xx → this message/number is unusable (invalid number, sender ID
//    not approved, …). Skipped, not retried.
//  - 429/5xx/network → transient; throw so the outbox retries with backoff.
export class TermiiSmsSender implements SmsSender {
  private readonly logger = new Logger(TermiiSmsSender.name);
  private disabledReason: string | null = null;

  constructor(private readonly config: TermiiConfig) {}

  isEnabled(): boolean {
    return this.disabledReason === null;
  }

  async send(message: SmsMessage): Promise<SmsSendResult> {
    if (this.disabledReason) {
      return { status: 'skipped', reason: this.disabledReason };
    }

    const response = await fetchWithPolicy(
      `${this.config.baseUrl.replace(/\/+$/, '')}/api/sms/send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.config.apiKey,
          // Termii wants the number without the leading '+'.
          to: message.to.replace(/^\+/, ''),
          from: this.config.senderId,
          sms: message.body,
          type: 'plain',
          channel: this.config.channel,
        }),
      },
      // Not retried here: a POST that sends an SMS isn't idempotent on
      // Termii's side. Transient failures throw and the outbox retries the
      // whole event later (at-least-once — an occasional duplicate SMS is
      // the accepted trade-off).
      { timeoutMs: 10_000, retries: 0 },
    );

    if (response.ok) {
      const body = (await response
        .json()
        .catch(() => ({}))) as TermiiSendResponse;
      return { status: 'sent', providerMessageId: body.message_id ?? null };
    }

    const detail = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      this.disabledReason = `Termii rejected the API key (HTTP ${response.status})`;
      this.logger.error(
        `${this.disabledReason} — SMS disabled until restart with a valid SMS_API_KEY.`,
      );
      return { status: 'skipped', reason: this.disabledReason };
    }
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`Termii transient failure HTTP ${response.status}`);
    }
    const reason = `Termii refused the message (HTTP ${response.status}): ${detail.slice(0, 200)}`;
    this.logger.warn(`${reason}${message.tag ? ` [${message.tag}]` : ''}`);
    return { status: 'skipped', reason };
  }
}
