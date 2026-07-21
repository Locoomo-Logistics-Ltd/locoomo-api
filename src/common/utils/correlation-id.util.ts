import { randomUUID } from 'crypto';

// Shared by the interceptor (the common path) and the exception filter
// (the fallback path — errors thrown from a Guard happen before any
// interceptor runs, so the filter can't assume request.correlationId is set).
export function resolveCorrelationId(
  headerValue: string | string[] | undefined,
): string {
  return (
    (Array.isArray(headerValue) ? headerValue[0] : headerValue) ?? randomUUID()
  );
}
