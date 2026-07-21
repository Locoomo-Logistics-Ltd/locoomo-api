import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, Observable } from 'rxjs';
import { SKIP_RESPONSE_ENVELOPE } from '../decorators/skip-response-envelope.decorator';
import { RequestWithCorrelationId } from './correlation-id.interceptor';

export interface SuccessResponseEnvelope<T> {
  success: true;
  data: T;
  meta: {
    correlationId: string;
    timestamp: string;
  };
}

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_RESPONSE_ENVELOPE,
      [context.getHandler(), context.getClass()],
    );
    if (skip) {
      return next.handle();
    }

    const request = context
      .switchToHttp()
      .getRequest<RequestWithCorrelationId>();

    return next.handle().pipe(
      map((data: unknown): SuccessResponseEnvelope<unknown> => ({
        success: true,
        data,
        meta: {
          correlationId: request.correlationId,
          timestamp: new Date().toISOString(),
        },
      })),
    );
  }
}
