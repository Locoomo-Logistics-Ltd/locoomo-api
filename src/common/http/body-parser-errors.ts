import type { ErrorRequestHandler } from 'express';
import {
  MalformedJsonException,
  PayloadTooLargeException,
  UnsupportedRequestBodyException,
} from '../exceptions/request-body.exceptions';

// body-parser reports failures as http-errors carrying a `type`. Without
// this, Nest turns invalid JSON into a 400 that echoes the parser's internal
// message, and lets an oversized body fall through as a 500. Registered
// right after the parsers so these become normal app exceptions that the
// global filter renders in the standard error envelope.
export function bodyParserErrorMapper(limit: string): ErrorRequestHandler {
  return (error: unknown, _req, _res, next) => {
    const type =
      typeof error === 'object' && error !== null && 'type' in error
        ? error.type
        : undefined;
    switch (type) {
      case 'entity.too.large':
        return next(new PayloadTooLargeException(limit));
      case 'entity.parse.failed':
        return next(new MalformedJsonException());
      case 'encoding.unsupported':
      case 'charset.unsupported':
        return next(new UnsupportedRequestBodyException());
      default:
        return next(error);
    }
  };
}
