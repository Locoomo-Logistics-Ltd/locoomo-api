import { hashPassword, verifyPassword } from './password-hasher';

describe('password-hasher', () => {
  it('produces a salt:key hex-encoded hash', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-Staple-1');

    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  it('salts each hash independently — same password, different output', async () => {
    const hashA = await hashPassword('Correct-Horse-Battery-Staple-1');
    const hashB = await hashPassword('Correct-Horse-Battery-Staple-1');

    expect(hashA).not.toBe(hashB);
  });

  it('verifies the correct password against its own hash', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-Staple-1');

    await expect(
      verifyPassword('Correct-Horse-Battery-Staple-1', hash),
    ).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-Staple-1');

    await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-valid-hash')).resolves.toBe(
      false,
    );
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'onlysalt:')).resolves.toBe(false);
  });

  it('round-trips correctly for an empty-string edge case password', async () => {
    const hash = await hashPassword('');

    await expect(verifyPassword('', hash)).resolves.toBe(true);
    await expect(verifyPassword('not-empty', hash)).resolves.toBe(false);
  });
});
