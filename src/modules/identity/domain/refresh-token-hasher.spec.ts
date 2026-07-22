import { hashRefreshToken } from './refresh-token-hasher';

describe('refresh-token-hasher', () => {
  it('produces a 64-char hex SHA-256 digest', () => {
    const hash = hashRefreshToken('some-random-token');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input, same output', () => {
    expect(hashRefreshToken('token-a')).toBe(hashRefreshToken('token-a'));
  });

  it('produces different output for different input', () => {
    expect(hashRefreshToken('token-a')).not.toBe(hashRefreshToken('token-b'));
  });
});
