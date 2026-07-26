export enum NodeOnboardingType {
  FIELD_RECRUITED = 'field_recruited',
  WARM_LEAD = 'warm_lead',
  CHAIN_PARTNER = 'chain_partner',
  FRANCHISE = 'franchise',
  // Self-registered via the public portal — only ever set by the
  // node-operators module's self-registration flow, never by an
  // Admin-initiated create.
  PORTAL = 'portal',
}
