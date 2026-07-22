import { validate } from 'class-validator';
import { Match } from './match.decorator';

class TestDto {
  password!: string;

  @Match('password')
  passwordConfirmation!: string;
}

describe('Match decorator', () => {
  it('passes validation when the fields are equal', async () => {
    const dto = new TestDto();
    dto.password = 'secret-value';
    dto.passwordConfirmation = 'secret-value';

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('fails validation when the fields differ', async () => {
    const dto = new TestDto();
    dto.password = 'secret-value';
    dto.passwordConfirmation = 'different-value';

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('passwordConfirmation');
    expect(errors[0].constraints).toEqual({
      Match: 'passwordConfirmation must match password',
    });
  });
});
