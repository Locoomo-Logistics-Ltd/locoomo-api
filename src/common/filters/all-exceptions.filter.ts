import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppException, InfrastructureException } from '../exceptions';
import { CORRELATION_ID_HEADER } from '../constants/correlation-id.constant';
import { RequestWithCorrelationId } from '../interceptors/correlation-id.interceptor';
import { resolveCorrelationId } from '../utils/correlation-id.util';
import { ErrorResponseEnvelope } from './error-response.envelope';

const HTTP_STATUS_ERROR_CODES: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_FAILED',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
};

// Single catch-all filter — every error the app produces, expected or not,
// resolves to the same {success:false, error:{...}} shape. Diagnostic detail
// (stack, internal context) is always logged, never returned to the client.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithCorrelationId>();

    const correlationId =
      request.correlationId ??
      resolveCorrelationId(request.headers[CORRELATION_ID_HEADER]);
    response.setHeader(CORRELATION_ID_HEADER, correlationId);

    const { httpStatus, body } = this.resolve(exception, correlationId);
    this.log(exception, body, request, correlationId);

    response.status(httpStatus).json(body);
  }

  private resolve(
    exception: unknown,
    correlationId: string,
  ): { httpStatus: number; body: ErrorResponseEnvelope } {
    if (exception instanceof AppException) {
      const message =
        exception instanceof InfrastructureException
          ? 'Something went wrong. Please try again.'
          : exception.message;

      return {
        httpStatus: exception.httpStatus,
        body: {
          success: false,
          error: { code: exception.errorCode, message, correlationId },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const { message, details } = this.parseHttpExceptionBody(exception);

      return {
        httpStatus: status,
        body: {
          success: false,
          error: {
            code: HTTP_STATUS_ERROR_CODES[status] ?? 'HTTP_ERROR',
            message,
            correlationId,
            ...(details !== undefined ? { details } : {}),
          },
        },
      };
    }

    return {
      httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong. Please try again.',
          correlationId,
        },
      },
    };
  }

  // Handles both Nest's default shape ({message: string | string[]}) and a
  // custom exceptionFactory's shape ({message: string, details: [...]})  —
  // the latter is how structured per-field validation errors get here.
  private parseHttpExceptionBody(exception: HttpException): {
    message: string;
    details?: unknown;
  } {
    const body = exception.getResponse();

    if (typeof body === 'string') {
      return { message: body };
    }

    if (typeof body === 'object' && body !== null) {
      const { message: rawMessage, details } = body as {
        message?: unknown;
        details?: unknown;
      };
      const message = Array.isArray(rawMessage)
        ? rawMessage.join('; ')
        : typeof rawMessage === 'string'
          ? rawMessage
          : exception.message;

      return details !== undefined ? { message, details } : { message };
    }

    return { message: exception.message };
  }

  private log(
    exception: unknown,
    body: ErrorResponseEnvelope,
    request: RequestWithCorrelationId,
    correlationId: string,
  ): void {
    const meta = JSON.stringify({
      correlationId,
      method: request.method,
      path: request.url,
    });

    if (exception instanceof InfrastructureException) {
      this.logger.error(
        `[${body.error.code}] ${exception.message} ${meta}`,
        exception.stack,
      );
      return;
    }

    if (
      exception instanceof AppException ||
      exception instanceof HttpException
    ) {
      this.logger.warn(`[${body.error.code}] ${body.error.message} ${meta}`);
      return;
    }

    const error =
      exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(`[INTERNAL_ERROR] ${error.message} ${meta}`, error.stack);
  }
}
