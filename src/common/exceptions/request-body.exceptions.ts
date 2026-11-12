import { BusinessException } from './business.exception';

export class PayloadTooLargeException extends BusinessException {
  readonly errorCode = 'PAYLOAD_TOO_LARGE';
  readonly httpStatus = 413;

  constructor(limit: string) {
    super(
      `Request body is larger than ${limit}. Split it up, or use the async import endpoint for large batches.`,
    );
  }
}

export class MalformedJsonException extends BusinessException {
  readonly errorCode = 'MALFORMED_JSON';
  readonly httpStatus = 400;

  constructor() {
    super('Request body is not valid JSON');
  }
}

export class UnsupportedRequestBodyException extends BusinessException {
  readonly errorCode = 'UNSUPPORTED_REQUEST_BODY';
  readonly httpStatus = 415;

  constructor() {
    super('Request body encoding or charset is not supported');
  }
}
