import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { InfrastructureException } from '../exceptions/infrastructure.exception';
import { EntityNotFoundException } from '../exceptions/entity-not-found.exception';
import { RequestWithCorrelationId } from '../interceptors/correlation-id.interceptor';
import { AllExceptionsFilter } from './all-exceptions.filter';

class TestInfrastructureException extends InfrastructureException {
  readonly errorCode = 'DB_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor() {
    super('connection terminated unexpectedly: pool exhausted', {
      host: 'internal-db-host',
    });
  }
}

function createHost(request: Partial<RequestWithCorrelationId>) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  const response = { status, setHeader };
  const fullRequest = { headers: {}, method: 'GET', url: '/test', ...request };

  const host = {
    switchToHttp: () => ({
      getRequest: () => fullRequest,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json, setHeader };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('maps a BusinessException to its declared status and code, message passed through', () => {
    const { host, status, json } = createHost({ correlationId: 'corr-1' });

    filter.catch(new EntityNotFoundException('Order', 'abc-123'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Order with id abc-123 was not found',
        correlationId: 'corr-1',
      },
    });
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('hides an InfrastructureException message from the client but logs it at error', () => {
    const { host, status, json } = createHost({ correlationId: 'corr-2' });

    filter.catch(new TestInfrastructureException(), host);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'DB_UNAVAILABLE',
        message: 'Something went wrong. Please try again.',
        correlationId: 'corr-2',
      },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('pool exhausted') as string,
      expect.anything(),
    );
  });

  it("maps Nest's built-in HttpException to a stable error code by status", () => {
    const { host, status, json } = createHost({ correlationId: 'corr-3' });

    filter.catch(new BadRequestException('email must be a valid email'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'email must be a valid email',
        correlationId: 'corr-3',
      },
    });
  });

  it('passes through structured details when an HttpException body includes them', () => {
    const { host, json } = createHost({ correlationId: 'corr-4' });
    const details = [
      {
        field: 'email',
        constraint: 'isEmail',
        message: 'must be a valid email',
      },
    ];

    filter.catch(
      new BadRequestException({ message: 'Validation failed', details }),
      host,
    );

    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        correlationId: 'corr-4',
        details,
      },
    });
  });

  it('falls back to a generic 500 for a completely unexpected error', () => {
    const { host, status, json } = createHost({ correlationId: 'corr-5' });

    filter.catch(new Error('unexpected null pointer'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
        correlationId: 'corr-5',
      },
    });
  });

  it('maps a ThrottlerException to 429 RATE_LIMITED', () => {
    const { host, status, json } = createHost({ correlationId: 'corr-6' });

    filter.catch(new ThrottlerException(), host);

    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'RATE_LIMITED' }) as unknown,
      }),
    );
  });

  it('resolves a correlation id even when the interceptor never ran (e.g. a Guard threw first)', () => {
    const { host, json } = createHost({
      correlationId: undefined,
      headers: { 'x-correlation-id': 'client-provided-id' },
    });

    filter.catch(new Error('boom'), host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          correlationId: 'client-provided-id',
        }) as unknown,
      }),
    );
  });
});
