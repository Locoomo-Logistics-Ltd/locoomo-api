import { QueryFailedError } from 'typeorm';
import { isUniqueViolation } from './is-unique-violation.util';

describe('isUniqueViolation', () => {
  it('returns true for a Postgres 23505 unique_violation error', () => {
    const error = new QueryFailedError('INSERT ...', undefined, {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    } as unknown as Error);

    expect(isUniqueViolation(error)).toBe(true);
  });

  it('returns false for a different Postgres error code', () => {
    const error = new QueryFailedError('INSERT ...', undefined, {
      code: '23503',
      message: 'foreign key violation',
    } as unknown as Error);

    expect(isUniqueViolation(error)).toBe(false);
  });

  it('returns false for a non-QueryFailedError', () => {
    expect(isUniqueViolation(new Error('something else'))).toBe(false);
    expect(isUniqueViolation('not even an error')).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
