import { SetMetadata } from '@nestjs/common';

export const SKIP_RESPONSE_ENVELOPE = 'skipResponseEnvelope';

// For endpoints consumed by infra, not app clients (health checks, webhook
// receivers) - their response shape is dictated by the consumer.
export const SkipResponseEnvelope = () =>
  SetMetadata(SKIP_RESPONSE_ENVELOPE, true);
