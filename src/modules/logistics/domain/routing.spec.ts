import { chooseProvider, ProviderRoutingConfig } from './routing';

describe('chooseProvider', () => {
  const inHouse: ProviderRoutingConfig = {
    key: 'in_house',
    enabled: true,
    priority: 1000,
    maxAttempts: 1,
    minDistanceKm: null,
    maxDistanceKm: null,
    pilotNodeIds: null,
    vehicleClasses: ['bicycle', 'motorbike', 'car'],
    maxCostShare: null,
  };
  const courier: ProviderRoutingConfig = {
    key: 'courier',
    enabled: true,
    priority: 10,
    maxAttempts: 2,
    minDistanceKm: 0.1,
    maxDistanceKm: 80,
    pilotNodeIds: null,
    vehicleClasses: ['motorbike', 'car'],
    maxCostShare: 0.75,
  };
  const registered = new Set(['in_house', 'courier']);
  const context = {
    originNodeId: 'yaba',
    distanceKm: 12,
    vehicleClass: 'motorbike',
    attemptsByProvider: {},
  };

  it('prefers the lowest priority number', () => {
    expect(chooseProvider([inHouse, courier], registered, context)?.key).toBe(
      'courier',
    );
  });

  it('falls back once a provider has used up its attempts', () => {
    expect(
      chooseProvider([inHouse, courier], registered, {
        ...context,
        attemptsByProvider: { courier: 2 },
      })?.key,
    ).toBe('in_house');
  });

  it('skips a provider outside its distance limits', () => {
    expect(
      chooseProvider([inHouse, courier], registered, {
        ...context,
        distanceKm: 120,
      })?.key,
    ).toBe('in_house');
    expect(
      chooseProvider([inHouse, courier], registered, {
        ...context,
        distanceKm: 0.05,
      })?.key,
    ).toBe('in_house');
  });

  it('restricts a pilot provider to its origin Nodes', () => {
    const pilot = { ...courier, pilotNodeIds: ['lekki'] };
    expect(chooseProvider([inHouse, pilot], registered, context)?.key).toBe(
      'in_house',
    );
    expect(
      chooseProvider([inHouse, pilot], registered, {
        ...context,
        originNodeId: 'lekki',
      })?.key,
    ).toBe('courier');
  });

  it('skips disabled providers and configured providers with no adapter', () => {
    expect(
      chooseProvider(
        [inHouse, { ...courier, enabled: false }],
        registered,
        context,
      )?.key,
    ).toBe('in_house');
    expect(
      chooseProvider([inHouse, courier], new Set(['in_house']), context)?.key,
    ).toBe('in_house');
  });

  it('only offers a parcel to providers with the vehicle it needs', () => {
    expect(
      chooseProvider([inHouse, courier], registered, {
        ...context,
        vehicleClass: 'bicycle',
      })?.key,
    ).toBe('in_house');
    expect(
      chooseProvider([courier], registered, {
        ...context,
        vehicleClass: 'van',
      }),
    ).toBeNull();
  });

  it('returns null when nothing qualifies', () => {
    expect(
      chooseProvider([{ ...inHouse, enabled: false }], registered, context),
    ).toBeNull();
  });
});
