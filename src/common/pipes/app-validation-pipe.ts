import { ValidationPipe } from '@nestjs/common';
import { createValidationException } from './validation-exception-factory';

// Shared by main.ts (real bootstrap) and e2e tests, so both exercise the
// exact same validation contract instead of two configs drifting apart.
export function createAppValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: createValidationException,
  });
}
