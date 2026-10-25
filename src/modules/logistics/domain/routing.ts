// Which courier gets a leg. Pure so the policy is unit-testable apart from
// the database: the router service just loads these inputs.

export interface ProviderRoutingConfig {
  key: string;
  enabled: boolean;
  priority: number;
  maxAttempts: number;
  minDistanceKm: number | null;
  maxDistanceKm: number | null;
  pilotNodeIds: string[] | null;
  // Vehicle classes the provider's adapter offers (from its capabilities).
  vehicleClasses: readonly string[];
  maxCostShare: number | null;
}

export interface RoutingContext {
  originNodeId: string;
  distanceKm: number;
  // The vehicle the parcel needs; null (orders from before vehicle
  // selection) matches any provider.
  vehicleClass: string | null;
  // Legs of this type the order has already had, per provider (any outcome).
  attemptsByProvider: Record<string, number>;
}

// The first provider, in priority order, that is enabled, has an adapter
// running in this process, hasn't used up its attempts on this order, is
// open to this origin Node (pilots), offers the vehicle the parcel needs,
// and serves this distance. null when none qualifies.
export function chooseProvider(
  configs: readonly ProviderRoutingConfig[],
  registeredKeys: ReadonlySet<string>,
  context: RoutingContext,
): ProviderRoutingConfig | null {
  const candidates = [...configs].sort(
    (a, b) => a.priority - b.priority || a.key.localeCompare(b.key),
  );
  return (
    candidates.find(
      (config) =>
        config.enabled &&
        registeredKeys.has(config.key) &&
        (context.attemptsByProvider[config.key] ?? 0) < config.maxAttempts &&
        (!config.pilotNodeIds?.length ||
          config.pilotNodeIds.includes(context.originNodeId)) &&
        (context.vehicleClass === null ||
          config.vehicleClasses.includes(context.vehicleClass)) &&
        (config.minDistanceKm === null ||
          context.distanceKm >= config.minDistanceKm) &&
        (config.maxDistanceKm === null ||
          context.distanceKm <= config.maxDistanceKm),
    ) ?? null
  );
}
