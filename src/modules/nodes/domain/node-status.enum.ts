export enum NodeStatus {
  // Registered but not yet reviewed — not visible in pickup-station
  // listings, can't participate in the delivery network.
  PENDING = 'pending',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}
