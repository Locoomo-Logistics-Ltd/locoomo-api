export enum RevenueSplitPartyType {
  RIDER = 'rider',
  NODE = 'node',
  // The destination Node's flat handling fee (PricingRule.destinationFeeKobo)
  // — a dedicated pass-through, not part of the rider/NODE/PLATFORM 60/20/20
  // split. NODE always means the origin Node (see RecordRevenueSplitService).
  DESTINATION_NODE = 'destination_node',
  PLATFORM = 'platform',
}
