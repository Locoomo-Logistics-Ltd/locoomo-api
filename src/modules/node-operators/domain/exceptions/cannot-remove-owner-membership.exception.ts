import { BusinessException } from '../../../../common/exceptions';

// Thrown by DELETE /node-operators/nodes/:nodeId/staff/:userId when the
// target membership's roleAtNode isn't STAFF — not reachable through the
// normal flow (GET .../staff only ever lists staff rows), but defended
// directly since :userId is caller-supplied. Not hidden as not-found: this
// is a validation error about what the endpoint does, not an
// existence-probe the hide-as-404 pattern exists to prevent.
export class CannotRemoveOwnerMembershipException extends BusinessException {
  readonly errorCode = 'CANNOT_REMOVE_OWNER_MEMBERSHIP';
  readonly httpStatus = 400;

  constructor() {
    super('This endpoint can only remove a staff membership, not an owner');
  }
}
