import {
  invoiceNumber,
  invoiceTotals,
  lagosMonth,
  nairaPlain,
  parseMonth,
  statementTotals,
  toCsv,
} from './statement';

describe('statement helpers', () => {
  it('parses Lagos months and refuses nonsense', () => {
    const range = parseMonth('2026-12')!;
    expect(range.start.toISOString()).toBe('2026-11-30T23:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-12-31T23:00:00.000Z');
    expect(parseMonth('2026-13')).toBeNull();
    expect(parseMonth('26-01')).toBeNull();
    expect(parseMonth('2026-1')).toBeNull();
  });

  it('places an instant in its Lagos month', () => {
    // 23:30 UTC on 31 October is already November in Lagos.
    expect(lagosMonth(new Date('2026-10-31T23:30:00Z'))).toBe('2026-11');
    expect(lagosMonth(new Date('2026-10-31T22:30:00Z'))).toBe('2026-10');
  });

  it('numbers invoices stably', () => {
    expect(
      invoiceNumber('2026-11', '0c7e5a7b-1234-4000-8000-000000000000'),
    ).toBe('LCM-INV-202611-0C7E5A7B');
  });

  it('totals a statement', () => {
    const totals = statementTotals(1_000, [
      {
        at: new Date(),
        type: 'top_up',
        description: '',
        amountKobo: 5_000,
        balanceAfterKobo: 6_000,
        reference: null,
        trackingCode: null,
      },
      {
        at: new Date(),
        type: 'shipment_charge',
        description: '',
        amountKobo: -2_000,
        balanceAfterKobo: 4_000,
        reference: 'R',
        trackingCode: 'LCM',
      },
    ]);
    expect(totals).toEqual({
      openingKobo: 1_000,
      closingKobo: 4_000,
      creditsKobo: 5_000,
      debitsKobo: -2_000,
      byType: { top_up: 5_000, shipment_charge: -2_000 },
    });
    expect(statementTotals(700, []).closingKobo).toBe(700);
  });

  it('bills shipping charges and re-pricing, with VAT only when charged', () => {
    const entries = [
      { type: 'shipment_charge', amountKobo: -107_500, shipmentId: 'a' },
      { type: 'shipment_charge', amountKobo: -107_500, shipmentId: 'b' },
      { type: 'shipment_adjustment', amountKobo: -10_000, shipmentId: 'a' },
      { type: 'shipment_adjustment', amountKobo: 2_500, shipmentId: 'b' },
      { type: 'top_up', amountKobo: 1_000_000, shipmentId: null },
    ];
    const withVat = invoiceTotals(entries, true);
    expect(withVat.lines).toEqual([
      {
        description: 'Parcel delivery to Locoomo Nodes',
        quantity: 2,
        amountKobo: 215_000,
      },
      {
        description: 'Re-pricing after measuring at drop-off',
        quantity: 2,
        amountKobo: 7_500,
      },
    ]);
    expect(withVat.totalKobo).toBe(222_500);
    expect(withVat.vatKobo).toBe(15_523);
    expect(withVat.netKobo).toBe(222_500 - 15_523);
    expect(invoiceTotals(entries, false).vatKobo).toBe(0);
  });

  it('writes CSV and plain naira', () => {
    expect(toCsv([['a', 'b,c', 'say "hi"', null, 5]])).toBe(
      'a,"b,c","say ""hi""",,5\r\n',
    );
    expect(nairaPlain(2_500_050)).toBe('25000.50');
    expect(nairaPlain(-5)).toBe('-0.05');
  });
});
