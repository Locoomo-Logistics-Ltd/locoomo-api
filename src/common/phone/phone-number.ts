import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { Transform } from 'class-transformer';
import { registerDecorator, ValidationOptions } from 'class-validator';

// Local formats ("0803 123 4567", "234803...") are read as Nigerian; anything
// written with a leading + keeps its own country code.
const DEFAULT_COUNTRY = 'NG';

// E.164 ("+2348031234567") for a valid number, null otherwise. Couriers and
// SMS providers want E.164, and storing one canonical form means two
// spellings of the same number compare equal.
export function toE164(input: string): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), DEFAULT_COUNTRY);
  return parsed?.isValid() ? parsed.number : null;
}

// Pair on a DTO field: @NormalizePhone() rewrites a valid number to E.164
// before validation runs (the app ValidationPipe has transform: true), and
// @IsPhoneE164() then rejects anything that didn't normalise. An invalid
// value is left untouched so the error message can echo what was sent.
export function NormalizePhone(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (toE164(value) ?? value) : value,
  );
}

export function IsPhoneE164(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'IsPhoneE164',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be a valid phone number`,
        ...validationOptions,
      },
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && toE164(value) === value;
        },
      },
    });
  };
}
