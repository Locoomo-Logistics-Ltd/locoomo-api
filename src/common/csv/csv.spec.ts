import { csvRow, nairaPlain } from './csv';

describe('csv', () => {
  it('quotes, escapes and defuses formulas', () => {
    expect(csvRow(['a', 'b,c', 'say "hi"', null, 5])).toBe(
      'a,"b,c","say ""hi""",,5\r\n',
    );
    expect(csvRow(['=HYPERLINK("x")', '-12.50', '@sum'])).toBe(
      `"'=HYPERLINK(""x"")",-12.50,'@sum\r\n`,
    );
    expect(nairaPlain(-5)).toBe('-0.05');
  });
});
