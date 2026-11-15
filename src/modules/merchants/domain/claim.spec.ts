import {
  claimAllowed,
  claimWindowOpen,
  maxPayoutKobo,
  parseClaimPayoutPayload,
} from './claim';
import { ShipmentStatus as S } from './shipment';

describe('claims', () => {
  it('allows lost only while in our care, damage after handover too', () => {
    expect(claimAllowed('lost', S.IN_TRANSIT)).toBe(true);
    expect(claimAllowed('lost', S.COLLECTED)).toBe(false);
    expect(claimAllowed('damaged', S.COLLECTED)).toBe(true);
    expect(claimAllowed('missing_item', S.RETURNED)).toBe(true);
    expect(claimAllowed('damaged', S.CREATED)).toBe(false);
    expect(claimAllowed('lost', S.CANCELLED)).toBe(false);
  });

  it('closes the window 30 days after the last status change', () => {
    const changed = new Date('2026-10-01T00:00:00Z');
    expect(claimWindowOpen(changed, new Date('2026-10-31T00:00:00Z'))).toBe(
      true,
    );
    expect(claimWindowOpen(changed, new Date('2026-10-31T00:00:01Z'))).toBe(
      false,
    );
  });

  it('pays the declared value, capped', () => {
    expect(maxPayoutKobo(2_000_000, 5_000_000)).toBe(2_000_000);
    expect(maxPayoutKobo(9_000_000, 5_000_000)).toBe(5_000_000);
    expect(maxPayoutKobo(null, 5_000_000)).toBe(5_000_000);
    expect(maxPayoutKobo(9_000_000, null)).toBe(9_000_000);
  });

  it('parses payout payloads strictly', () => {
    expect(
      parseClaimPayoutPayload({
        claimId: 'c',
        amountKobo: 100,
        merchantNote: null,
      }),
    ).toEqual({ claimId: 'c', amountKobo: 100, merchantNote: null });
    expect(parseClaimPayoutPayload({ claimId: 'c', amountKobo: 0 })).toBeNull();
    expect(
      parseClaimPayoutPayload({ claimId: 'c', amountKobo: 1.5 }),
    ).toBeNull();
  });
});
