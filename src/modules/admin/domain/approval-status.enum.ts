export enum ApprovalStatus {
  PENDING = 'pending',
  // Approved and the action ran successfully (same transaction).
  EXECUTED = 'executed',
  REJECTED = 'rejected',
  // Withdrawn by the admin who requested it.
  CANCELLED = 'cancelled',
  // Nobody decided within APPROVAL_TTL_DAYS — must be re-requested so a
  // stale request can't be approved against changed circumstances.
  EXPIRED = 'expired',
}
