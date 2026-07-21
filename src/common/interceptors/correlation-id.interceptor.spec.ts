import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { CORRELATION_ID_HEADER } from '../constants/correlation-id.constant';
import {
  CorrelationIdInterceptor,
  RequestWithCorrelationId,
} from './correlation-id.interceptor';

function createContext(headers: Record<string, string | string[] | undefined>) {
  const request = { headers } as RequestWithCorrelationId;
  const response = { setHeader: jest.fn() };

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  const next: CallHandler = { handle: () => of('ok') };

  return { context, next, request, response };
}

describe('CorrelationIdInterceptor', () => {
  const interceptor = new CorrelationIdInterceptor();

  it('generates a correlation id when none is provided', (done) => {
    const { context, next, request, response } = createContext({});

    interceptor.intercept(context, next).subscribe(() => {
      expect(request.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(response.setHeader).toHaveBeenCalledWith(
        CORRELATION_ID_HEADER,
        request.correlationId,
      );
      done();
    });
  });

  it('reuses an incoming correlation id instead of generating a new one', (done) => {
    const { context, next, request } = createContext({
      [CORRELATION_ID_HEADER]: 'client-generated-id-123',
    });

    interceptor.intercept(context, next).subscribe(() => {
      expect(request.correlationId).toBe('client-generated-id-123');
      done();
    });
  });
});
