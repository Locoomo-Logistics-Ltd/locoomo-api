import { BusinessException } from '../../../../common/exceptions';

// Removing `super` from the last active super admin would leave nobody able
// to grant permissions ever again — not recoverable through the API.
export class LastSuperAdminException extends BusinessException {
  readonly errorCode = 'LAST_SUPER_ADMIN';
  readonly httpStatus = 409;

  constructor() {
    super('At least one active admin must keep the super permission');
  }
}
