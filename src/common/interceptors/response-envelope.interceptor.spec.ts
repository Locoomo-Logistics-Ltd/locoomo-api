import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { RequestWithCorrelationId } from './correlation-id.interceptor';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

function createContext(correlationId: string) {
  const request = { correlationId } as RequestWithCorrelationId;

  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;

  return context;
}

describe('ResponseEnvelopeInterceptor', () => {
  it('wraps the handler result in a success envelope', (done) => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const interceptor = new ResponseEnvelopeInterceptor(reflector);
    const context = createContext('corr-1');
    const next: CallHandler = { handle: () => of({ id: 1, name: 'Node A' }) };

    interceptor.intercept(context, next).subscribe((result) => {
      expect(result).toEqual({
        success: true,
        data: { id: 1, name: 'Node A' },
        meta: {
          correlationId: 'corr-1',
          timestamp: expect.any(String) as string,
        },
      });
      done();
    });
  });

  it('passes the raw handler result through unwrapped when marked skip', (done) => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(true),
    } as unknown as Reflector;
    const interceptor = new ResponseEnvelopeInterceptor(reflector);
    const context = createContext('corr-2');
    const next: CallHandler = { handle: () => of({ status: 'ok' }) };

    interceptor.intercept(context, next).subscribe((result) => {
      expect(result).toEqual({ status: 'ok' });
      done();
    });
  });
});
