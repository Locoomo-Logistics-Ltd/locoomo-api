export interface SmsMessage {
  // E.164 ("+2348031234567").
  to: string;
  body: string;
  // Short label for logs/metrics, e.g. 'collection_code'. Never the body —
  // bodies can carry one-time codes.
  tag?: string;
}

export type SmsSendResult =
  | { status: 'sent'; providerMessageId: string | null }
  // Deliberately not sent and not worth retrying: SMS disabled, provider
  // rejected our credentials, or the number is unusable. The flow that
  // queued the SMS has other channels and carries on (plan D10).
  | { status: 'skipped'; reason: string };

// Throw only for transient trouble (network, provider 5xx/429) — the outbox
// retries those with backoff. Anything permanent returns `skipped`.
export interface SmsSender {
  // False when no provider/key is configured, or the provider rejected the
  // key — callers can use this to skip enqueueing at all.
  isEnabled(): boolean;
  send(message: SmsMessage): Promise<SmsSendResult>;
}

// Keep SMS bodies within one GSM-7 segment where possible; beyond this we
// still send (providers concatenate) but it costs multiple units.
export const SMS_SINGLE_SEGMENT_CHARS = 160;
