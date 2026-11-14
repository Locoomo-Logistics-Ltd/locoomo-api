import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RequestWithUser } from '../auth.guard';

// The caller as a Principal (cookie user or API key). Use on routes that
// accept both (@AllowApiKey); @CurrentUser stays for cookie-only routes.
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<RequestWithUser>().principal,
);
