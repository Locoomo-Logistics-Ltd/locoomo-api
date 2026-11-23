import { firstName, newPickToken, pickLinkStatus } from './pick-link';

describe('pick links', () => {
  it('makes url-safe tokens', () => {
    expect(newPickToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('reports an open link past its date as expired', () => {
    const past = new Date(Date.now() - 1000);
    expect(pickLinkStatus('open', past)).toBe('expired');
    expect(pickLinkStatus('used', past)).toBe('used');
    expect(pickLinkStatus('open', new Date(Date.now() + 60_000))).toBe('open');
  });

  it('shows the buyer only a first name', () => {
    expect(firstName('  Chioma  Okafor ')).toBe('Chioma');
  });
});
