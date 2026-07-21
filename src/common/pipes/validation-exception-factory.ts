import { BadRequestException } from '@nestjs/common';
import { ValidationError } from 'class-validator';

export interface ValidationDetail {
  field: string;
  constraint: string;
  message: string;
}

// Flat DTOs only for now — no nested/array validation (error.children) exists
// anywhere in the app yet. Extend when a real nested DTO shows up.
function toValidationDetails(errors: ValidationError[]): ValidationDetail[] {
  return errors.flatMap((error) =>
    Object.entries(error.constraints ?? {}).map(([constraint, message]) => ({
      field: error.property,
      constraint,
      message,
    })),
  );
}

export function createValidationException(
  errors: ValidationError[],
): BadRequestException {
  return new BadRequestException({
    message: 'Validation failed',
    details: toValidationDetails(errors),
  });
}
