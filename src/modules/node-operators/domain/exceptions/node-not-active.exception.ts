import { AuthorizationException } from '../../../../common/exceptions';

// Thrown by the staff-invite flow when the target Node hasn't been
// Admin-approved yet — inviting help to run a Node that isn't operating
// yet doesn't make sense. Not hidden as not-found (unlike a Node the caller
// doesn't own at all): the caller already legitimately owns and can see
// this Node's status via GET /me/nodes, so a clear message serves them
// better than a confusing 404. Same 403 bracket as RIDER_NOT_ACTIVE — "the
// resource this actor is tied to isn't active yet."
export class NodeNotActiveException extends AuthorizationException {
  readonly errorCode = 'NODE_NOT_ACTIVE';
  readonly httpStatus = 403;

  constructor() {
    super('This Node has not been approved yet');
  }
}
