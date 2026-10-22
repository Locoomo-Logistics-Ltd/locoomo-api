export enum RevenueSplitPartyType {
  RIDER = 'rider',
  NODE = 'node',
  // The destination Node's flat handling fee (PricingRule.destinationFeeKobo)
  // — a dedicated pass-through, not part of the rider/NODE/PLATFORM 60/20/20
  // split. NODE always means the origin Node (see RecordRevenueSplitService).
  DESTINATION_NODE = 'destination_node',
  PLATFORM = 'platform',
  // Pilot settlement for orders an external courier (Sendii) delivered: the
  // rider's share, recorded but never paid out — the courier was paid from
  // its prepaid wallet, and how this share is finally split hasn't been
  // agreed yet. partyId is null; payoutStatus is NOT_PAYABLE.
  COURIER_ALLOCATION = 'courier_allocation',
}
