import { BadRequestException } from '@nestjs/common';
import { ValidationError } from 'class-validator';

export interface ValidationDetail {
  // Dotted path to the offending value: "email", "receiver.phone",
  // "items[3].receiver.phone" — exactly where a form/import row should
  // show the error.
  field: string;
  constraint: string;
  message: string;
}

// class-validator reports nested objects (@ValidateNested) and array
// elements as `children`, where an array element's `property` is its index
// ("3"). Walk the tree depth-first so every leaf constraint becomes one
// detail with its full path.
function toValidationDetails(
  errors: ValidationError[],
  parentPath = '',
): ValidationDetail[] {
  return errors.flatMap((error) => {
    const path = joinPath(parentPath, error.property);
    const own = Object.entries(error.constraints ?? {}).map(
      ([constraint, message]) => ({ field: path, constraint, message }),
    );
    const nested = error.children?.length
      ? toValidationDetails(error.children, path)
      : [];
    return [...own, ...nested];
  });
}

function joinPath(parent: string, property: string): string {
  if (/^\d+$/.test(property)) {
    return `${parent}[${property}]`;
  }
  return parent ? `${parent}.${property}` : property;
}

export function createValidationException(
  errors: ValidationError[],
): BadRequestException {
  return new BadRequestException({
    message: 'Validation failed',
    details: toValidationDetails(errors),
  });
}
