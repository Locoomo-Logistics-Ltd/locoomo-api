import { BusinessException } from '../../../../common/exceptions';

export class InvalidVerificationDocumentException extends BusinessException {
  readonly errorCode = 'INVALID_VERIFICATION_DOCUMENT';
  readonly httpStatus = 400;

  constructor() {
    super(
      'The referenced verification document could not be confirmed — please re-upload and try again',
    );
  }
}
