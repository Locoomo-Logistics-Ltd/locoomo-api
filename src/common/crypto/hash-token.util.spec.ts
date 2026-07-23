import { hashToken } from './hash-token.util';

describe('hashToken', () => {
  it('produces a 64-char hex SHA-256 digest', () => {
    expect(hashToken('some-random-token')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input, same output', () => {
    expect(hashToken('token-a')).toBe(hashToken('token-a'));
  });

  it('produces different output for different input', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
  });
});
