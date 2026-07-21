import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { CORRELATION_ID_HEADER } from '../constants/correlation-id.constant';
import { resolveCorrelationId } from '../utils/correlation-id.util';

export interface RequestWithCorrelationId extends Request {
  correlationId: string;
}

// Respects an incoming X-Correlation-Id (the offline-queued Node Operator PWA
// generates one at scan time, before it ever reaches the network) and
// generates one otherwise. Available on `request.correlationId` for anything
// downstream — the response envelope, the exception filter, later the logger.
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithCorrelationId>();
    const response = http.getResponse<Response>();

    const correlationId = resolveCorrelationId(
      request.headers[CORRELATION_ID_HEADER],
    );

    request.correlationId = correlationId;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);

    return next.handle();
  }
}
