import { firstName, labelContent, LabelSource, phoneLast4 } from './label';

const source: LabelSource = {
  mode: 'live',
  trackingCode: 'LCM-7K3M-Q9TD',
  reference: 'TEMU-88412-1',
  receiverName: 'Chioma Adaeze Okafor',
  receiverPhone: '+2348031234567',
  merchantName: 'Ada Stores',
  origin: { nodeName: 'Ikeja Node' },
  destination: {
    nodeName: 'Yaba Node',
    address: '312 Herbert Macaulay Way',
    city: 'Lagos',
    state: 'Lagos',
  },
  parcel: {
    size: 'extra_large',
    handling: ['fragile', 'keep_upright'],
    weightKg: 2.5,
  },
  createdAt: new Date('2026-11-15T09:00:00Z'),
};

describe('shipping label content', () => {
  it('keeps receiver details to a first name and the last 4 phone digits', () => {
    const label = labelContent(source);
    expect(label.receiver).toBe('Chioma · phone ending 4567');
    expect(JSON.stringify(label)).not.toContain('8031234567');
    expect(JSON.stringify(label)).not.toContain('Okafor');
  });

  it('encodes the tracking code and describes the route and parcel', () => {
    expect(labelContent(source)).toMatchObject({
      test: false,
      scanValue: 'LCM-7K3M-Q9TD',
      toNode: 'Yaba Node',
      toAddress: '312 Herbert Macaulay Way, Lagos, Lagos',
      from: 'Ada Stores',
      dropOffAt: 'Ikeja Node',
      details: 'Size extra large · 2.5 kg · 2026-11-15',
      handling: ['FRAGILE', 'THIS WAY UP'],
    });
  });

  it('marks test labels', () => {
    expect(labelContent({ ...source, mode: 'test' }).test).toBe(true);
  });

  it('handles odd names and phone formats', () => {
    expect(firstName('  Ada  ')).toBe('Ada');
    expect(phoneLast4('0803 123 4567')).toBe('4567');
  });
});
