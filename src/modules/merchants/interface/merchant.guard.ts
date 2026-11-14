import {
  applyDecorators,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { RequestWithUser } from '../../../common/auth/auth.guard';
import { AllowApiKey } from '../../../common/auth/decorators/allow-api-key.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { auditContextFrom } from '../../../common/audit/audit.service';
import { Env } from '../../../config/env.validation';
import {
  MerchantContextService,
  MerchantMembership,
} from '../application/merchant-context.service';
import type {
  MerchantActor,
  MerchantCaller,
} from '../application/merchant-state';
import type { ApiKeyMode, ApiKeyScope } from '../domain/api-key';
import {
  AdminsCannotJoinMerchantsException,
  InvalidModeException,
  MerchantPermissionDeniedException,
  MerchantPlatformDisabledException,
  NotAMerchantMemberException,
} from '../domain/exceptions/merchant.exceptions';
import {
  MerchantPermission,
  roleHasPermission,
} from '../domain/merchant-permissions';

export const MERCHANT_ACCESS_KEY = 'merchantAccess';
const ANY_MEMBER = 'member';

// Route needs a merchant membership — with this team permission, or any
// role when omitted. Routes without it (create a merchant, accept an
// invite) still get the kill switch and the no-admins rule.
export const MerchantAccess = (
  permission?: MerchantPermission,
): MethodDecorator & ClassDecorator =>
  SetMetadata(MERCHANT_ACCESS_KEY, permission ?? ANY_MEMBER);

// Integrator API route usable with an API key (needing `scope`) or a
// dashboard session (needing team `permission`). Handlers read the caller
// with @CurrentMerchantCaller(): merchant + mode, however they came in.
export const MERCHANT_API_KEY = 'merchantApi';
export const MerchantApi = (
  scope: ApiKeyScope,
  permission: MerchantPermission,
): MethodDecorator & ClassDecorator =>
  applyDecorators(
    AllowApiKey(scope),
    MerchantAccess(permission),
    SetMetadata(MERCHANT_API_KEY, true),
  );

// Dashboard sessions pick test or live per request (the Test/Live toggle).
export const MODE_HEADER = 'locoomo-mode';

export interface RequestWithMerchant extends RequestWithUser {
  merchant?: MerchantMembership;
  merchantCaller?: Omit<MerchantCaller, 'context'>;
}

// Controller-level (@UseGuards) on every /merchant dashboard controller.
// Runs after the global guards, so the session, CSRF, verified email and
// step-up checks have already passed.
@Injectable()
export class MerchantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly contextService: MerchantContextService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.get('MERCHANT_PLATFORM_ENABLED', { infer: true })) {
      throw new MerchantPlatformDisabledException();
    }
    const request = context.switchToHttp().getRequest<RequestWithMerchant>();
    const targets = [context.getHandler(), context.getClass()];
    const principal = request.principal;
    if (principal?.kind === 'api_key') {
      // Scopes were checked by AuthGuard; the key fixes merchant and mode.
      request.merchantCaller = {
        merchantId: principal.merchantId,
        mode: principal.mode,
        via: 'api_key',
        keyId: principal.keyId,
        userId: null,
      };
      return true;
    }
    const user = request.user;
    if (!user) {
      // @Public routes (invite preview).
      return true;
    }
    // Plan E1: Locoomo staff never sit on a merchant team.
    if (user.role === UserRole.ADMIN) {
      throw new AdminsCannotJoinMerchantsException();
    }

    const required = this.reflector.getAllAndOverride<string | undefined>(
      MERCHANT_ACCESS_KEY,
      targets,
    );
    if (required === undefined) {
      return true;
    }
    const membership = await this.contextService.membershipFor(user.id);
    if (!membership) {
      throw new NotAMerchantMemberException();
    }
    if (
      required !== ANY_MEMBER &&
      !roleHasPermission(membership.role, required as MerchantPermission)
    ) {
      throw new MerchantPermissionDeniedException(required);
    }
    request.merchant = membership;
    if (this.reflector.getAllAndOverride<boolean>(MERCHANT_API_KEY, targets)) {
      request.merchantCaller = {
        merchantId: membership.merchantId,
        mode: modeFrom(request.headers[MODE_HEADER]),
        via: 'session',
        keyId: null,
        userId: user.id,
        reauthAt: user.reauthAt,
      };
    }
    return true;
  }
}

function modeFrom(header: string | string[] | undefined): ApiKeyMode {
  if (header === undefined || header === '') {
    return 'test';
  }
  if (header === 'test' || header === 'live') {
    return header;
  }
  throw new InvalidModeException();
}

// Who is calling a @MerchantApi route.
export const CurrentMerchantCaller = createParamDecorator(
  (_data: unknown, context: ExecutionContext): MerchantCaller => {
    const request = context.switchToHttp().getRequest<RequestWithMerchant>();
    if (!request.merchantCaller) {
      throw new Error('CurrentMerchantCaller used without @MerchantApi');
    }
    return { ...request.merchantCaller, context: auditContextFrom(request) };
  },
);

// The acting team member, for routes behind @MerchantAccess.
export const CurrentMerchantActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): MerchantActor => {
    const request = context.switchToHttp().getRequest<RequestWithMerchant>();
    if (!request.user || !request.merchant) {
      // Programming error: route is missing @MerchantAccess.
      throw new Error('CurrentMerchantActor used without @MerchantAccess');
    }
    return {
      userId: request.user.id,
      merchantId: request.merchant.merchantId,
      memberId: request.merchant.memberId,
      role: request.merchant.role,
      reauthAt: request.user.reauthAt,
      context: auditContextFrom(request),
    };
  },
);
