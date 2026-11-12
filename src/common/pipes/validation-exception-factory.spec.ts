import { ValidationError } from 'class-validator';
import { createValidationException } from './validation-exception-factory';

function buildError(
  property: string,
  constraints: Record<string, string>,
): ValidationError {
  const error = new ValidationError();
  error.property = property;
  error.constraints = constraints;
  return error;
}

describe('createValidationException', () => {
  it('flattens class-validator errors into field/constraint/message details', () => {
    const errors = [
      buildError('email', { isEmail: 'email must be a valid email' }),
      buildError('parcelSize', {
        isEnum: 'parcelSize must be one of S, M, L, XL',
      }),
    ];

    const exception = createValidationException(errors);
    const body = exception.getResponse() as {
      message: string;
      details: unknown;
    };

    expect(exception.getStatus()).toBe(400);
    expect(body.message).toBe('Validation failed');
    expect(body.details).toEqual([
      {
        field: 'email',
        constraint: 'isEmail',
        message: 'email must be a valid email',
      },
      {
        field: 'parcelSize',
        constraint: 'isEnum',
        message: 'parcelSize must be one of S, M, L, XL',
      },
    ]);
  });

  it('emits one detail per failed constraint when a field fails multiple rules', () => {
    const errors = [
      buildError('receiverEmail', {
        isEmail: 'receiverEmail must be a valid email',
        isNotEmpty: 'receiverEmail should not be empty',
      }),
    ];

    const details = (
      createValidationException(errors).getResponse() as { details: unknown[] }
    ).details;

    expect(details).toHaveLength(2);
  });

  it('flattens nested objects and array elements into full paths', () => {
    const phone = buildError('phone', { isPhoneE164: 'phone must be valid' });
    const receiver = buildError('receiver', {});
    receiver.children = [phone];
    const item = buildError('3', {});
    item.children = [receiver];
    const items = buildError('items', {});
    items.children = [item];
    const shallow = buildError('receiver', {});
    shallow.children = [buildError('name', { isNotEmpty: 'name required' })];

    const details = (
      createValidationException([items, shallow]).getResponse() as {
        details: unknown[];
      }
    ).details;

    expect(details).toEqual([
      {
        field: 'items[3].receiver.phone',
        constraint: 'isPhoneE164',
        message: 'phone must be valid',
      },
      {
        field: 'receiver.name',
        constraint: 'isNotEmpty',
        message: 'name required',
      },
    ]);
  });

  it('produces an empty details array for no errors', () => {
    const details = (
      createValidationException([]).getResponse() as { details: unknown[] }
    ).details;

    expect(details).toEqual([]);
  });
});
