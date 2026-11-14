import { BusinessException } from '../../../../common/exceptions';

export class IdCheckFailedException extends BusinessException {
  readonly errorCode = 'ID_CHECK_FAILED';
  readonly httpStatus = 422;

  constructor(attemptsLeft: number) {
    super(
      attemptsLeft > 0
        ? "The phone number doesn't match the receiver's. Check it with the person collecting."
        : 'Too many wrong attempts. This parcel can now only be collected with its code.',
    );
    this.details = { attemptsLeft };
  }
}

export class IdCheckLockedException extends BusinessException {
  readonly errorCode = 'ID_CHECK_LOCKED';
  readonly httpStatus = 409;

  constructor() {
    super(
      'ID-check collection is locked after 5 wrong attempts. Collect with the code (resend it if needed).',
    );
  }
}

export class CounterUploadNotFoundException extends BusinessException {
  readonly errorCode = 'UPLOAD_NOT_FOUND';
  readonly httpStatus = 422;

  constructor() {
    super('We couldn’t find that photo. Take and upload it again.');
  }
}
