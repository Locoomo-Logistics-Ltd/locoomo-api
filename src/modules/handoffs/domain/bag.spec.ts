import { newBagCode, normaliseBagCode } from './bag';

describe('bags', () => {
  it('makes tag codes and reads them back however they are typed', () => {
    expect(newBagCode()).toMatch(/^BAG-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(normaliseBagCode('bag 7kq2 m9xd')).toBe('BAG-7KQ2-M9XD');
    expect(normaliseBagCode('BAG7KQ2M9XD')).toBe('BAG-7KQ2-M9XD');
    expect(normaliseBagCode('LCM-7KQ2-M9XD')).toBeNull();
  });
});
