import { InfrastructureException } from '../../../../common/exceptions';

// A courier's API failed or timed out while a person was waiting on it
// (e.g. fetching handover codes for the Node screen). Safe to retry.
export class LogisticsProviderUnavailableException extends InfrastructureException {
  readonly errorCode = 'LOGISTICS_PROVIDER_ERROR';
  readonly httpStatus = 502;

  constructor(providerKey: string, operation: string, detail: string) {
    super(`${providerKey} ${operation} failed: ${detail}`, {
      providerKey,
      operation,
    });
  }
}
