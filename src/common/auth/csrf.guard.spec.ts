import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { CsrfHeaderMissingException } from '../exceptions/csrf-header-missing.exception';
import { CSRF_HEADER, CsrfGuard } from './csrf.guard';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guard(mode: 'off' | 'report' | 'enforce'): CsrfGuard {
  return new CsrfGuard({
    get: () => mode,
  } as unknown as ConfigService<Env, true>);
}

const withSession = (
  method: string,
  headers: Record<string, string> = {},
): Record<string, unknown> => ({
  method,
  path: '/api/v1/x',
  headers,
  cookies: { access_token: 'jwt' },
});

describe('CsrfGuard', () => {
  it('blocks a cookie-authenticated mutation without the header when enforcing', () => {
    expect(() =>
      guard('enforce').canActivate(contextFor(withSession('POST'))),
    ).toThrow(CsrfHeaderMissingException);
  });

  it('allows the same request once the header is present', () => {
    expect(
      guard('enforce').canActivate(
        contextFor(withSession('PATCH', { [CSRF_HEADER]: 'web' })),
      ),
    ).toBe(true);
  });

  it('never blocks safe methods', () => {
    expect(guard('enforce').canActivate(contextFor(withSession('GET')))).toBe(
      true,
    );
  });

  it('ignores requests without a session cookie (API keys, webhooks, login)', () => {
    expect(
      guard('enforce').canActivate(
        contextFor({ method: 'POST', path: '/x', headers: {}, cookies: {} }),
      ),
    ).toBe(true);
  });

  it('only logs in report mode, and does nothing when off', () => {
    expect(guard('report').canActivate(contextFor(withSession('POST')))).toBe(
      true,
    );
    expect(guard('off').canActivate(contextFor(withSession('DELETE')))).toBe(
      true,
    );
  });
});
