// A user's relationship to one specific Node — OWNER is whoever
// onboarded/added the Node (payout account, staff invites); STAFF (Phase 2)
// can perform operational work (handoff scans) at the Node but not touch
// payout or invite others.
export enum NodeMembershipRole {
  OWNER = 'owner',
  STAFF = 'staff',
}
