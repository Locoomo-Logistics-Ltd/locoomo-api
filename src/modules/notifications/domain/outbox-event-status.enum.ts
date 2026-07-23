export enum OutboxEventStatus {
  PENDING = 'pending',
  SENT = 'sent',
  // Terminal — only reached after MAX_ATTEMPTS failures or an unrecognized
  // eventType. Needs a human, not a retry.
  FAILED = 'failed',
}
