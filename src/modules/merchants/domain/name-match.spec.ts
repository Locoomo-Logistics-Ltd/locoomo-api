import {
  bestNameMatch,
  nameMatchLevel,
  nameSimilarity,
  nameTokens,
} from './name-match';

describe('name matching (bank account holder vs merchant names)', () => {
  it('drops punctuation, accents and company boilerplate', () => {
    expect(nameTokens('Adé Stores Nig. Ltd')).toEqual(['ADE', 'STORES']);
  });

  it.each([
    ['OKAFOR ADA CHIOMA', 'Ada Okafor', 1],
    ['ADA STORES LIMITED', 'Ada Stores Ltd', 1],
    ['CHUKWUEMEKA OBI', 'Chukwu Obi', 1],
    ['OLUWASEUN ADEBAYO', 'Oluwaseun Adebayp', 1],
  ])('treats %s and %s as the same name', (bank, given, expected) => {
    expect(nameSimilarity(bank, given)).toBe(expected);
  });

  it('scores a partial overlap between 0 and 1', () => {
    const score = nameSimilarity('ADA OKAFOR', 'Ada Nwosu');
    expect(score).toBe(0.5);
    expect(nameMatchLevel(score)).toBe('partial');
  });

  it('discounts a single shared word against a longer name', () => {
    expect(nameSimilarity('ADA', 'Ada Okafor')).toBe(0.7);
  });

  it('scores unrelated names as weak', () => {
    const score = nameSimilarity('BELLO MUSA', 'Ada Okafor');
    expect(score).toBe(0);
    expect(nameMatchLevel(score)).toBe('weak');
  });

  it('takes the best of the legal name, trading name and directors', () => {
    expect(
      bestNameMatch('OKAFOR ADA', ['Kwik Deals Ltd', null, 'Ada Okafor']),
    ).toBe(1);
    expect(bestNameMatch('OKAFOR ADA', [])).toBe(0);
  });
});
