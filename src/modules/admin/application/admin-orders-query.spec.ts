import { maskEmail, maskPhone } from './admin-orders-query.service';

describe('contact masking for support', () => {
  it('keeps the last four phone digits and the email domain', () => {
    expect(maskPhone('08031234567')).toBe('*******4567');
    expect(maskPhone('123')).toBe('123');
    expect(maskEmail('chioma@example.com')).toBe('c*****@example.com');
    expect(maskEmail('a@b.co')).toBe('a*@b.co');
  });
});
