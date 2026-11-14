import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../../common/auth/user-role.enum';
import { Env } from '../../../config/env.validation';
import {
  MerchantContextService,
  MerchantMembership,
} from '../application/merchant-context.service';
import { MerchantRole } from '../domain/merchant.enums';
import { MerchantPermission } from '../domain/merchant-permissions';
import {
  MERCHANT_ACCESS_KEY,
  MerchantGuard,
  RequestWithMerchant,
} from './merchant.guard';

describe('MerchantGuard', () => {
  const membership: MerchantMembership = {
    merchantId: 'm1',
    memberId: 'mem1',
    role: MerchantRole.DEVELOPER,
  };

  function setup(options: {
    enabled?: boolean;
    access?: string;
    role?: UserRole;
    anonymous?: boolean;
    member?: MerchantMembership | null;
  }) {
    const request = {
      user: options.anonymous
        ? undefined
        : { id: 'u1', role: options.role ?? UserRole.CONSUMER },
    } as RequestWithMerchant;
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === MERCHANT_ACCESS_KEY ? options.access : undefined,
    } as unknown as Reflector;
    const contextService = {
      membershipFor: jest
        .fn()
        .mockResolvedValue(
          options.member === undefined ? membership : options.member,
        ),
    } as unknown as MerchantContextService;
    const config = {
      get: () => options.enabled ?? true,
    } as unknown as ConfigService<Env, true>;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
    return {
      run: () =>
        new MerchantGuard(reflector, contextService, config).canActivate(
          context,
        ),
      request,
    };
  }

  it('answers 503 for everyone while the kill switch is off', async () => {
    await expect(setup({ enabled: false }).run()).rejects.toMatchObject({
      errorCode: 'MERCHANT_PLATFORM_DISABLED',
      httpStatus: 503,
    });
    await expect(
      setup({ enabled: false, anonymous: true }).run(),
    ).rejects.toMatchObject({ errorCode: 'MERCHANT_PLATFORM_DISABLED' });
  });

  it('keeps Locoomo admins off merchant routes', async () => {
    await expect(setup({ role: UserRole.ADMIN }).run()).rejects.toMatchObject({
      errorCode: 'ADMINS_CANNOT_JOIN_MERCHANTS',
    });
  });

  it('lets routes without @MerchantAccess through for non-members', async () => {
    await expect(setup({ member: null }).run()).resolves.toBe(true);
  });

  it('requires a membership on @MerchantAccess routes', async () => {
    await expect(
      setup({ access: 'member', member: null }).run(),
    ).rejects.toMatchObject({ errorCode: 'NOT_A_MERCHANT_MEMBER' });
  });

  it('checks the role’s permission and attaches the membership', async () => {
    const allowed = setup({ access: MerchantPermission.DEVELOPERS_MANAGE });
    await expect(allowed.run()).resolves.toBe(true);
    expect(allowed.request.merchant).toEqual(membership);

    await expect(
      setup({ access: MerchantPermission.TEAM_MANAGE }).run(),
    ).rejects.toMatchObject({
      errorCode: 'MERCHANT_PERMISSION_DENIED',
      details: { permission: 'team.manage' },
    });
  });
});
