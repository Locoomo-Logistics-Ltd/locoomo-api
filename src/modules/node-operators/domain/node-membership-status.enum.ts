// Soft-status for a membership row — never hard-deleted, same instinct as
// NodeStatus/UserStatus. REMOVED means an owner revoked this person's
// access to this specific Node; it doesn't touch their User account or any
// other membership they hold elsewhere.
export enum NodeMembershipStatus {
  ACTIVE = 'active',
  REMOVED = 'removed',
}
