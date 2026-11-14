import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { AuditService } from '../../../common/audit/audit.service';
import { assertRecentAuth } from '../../../common/auth/recent-auth';
import { EntityNotFoundException } from '../../../common/exceptions';
import { MfaService } from '../../identity/application/mfa.service';
import {
  ApiKeyMode,
  DEFAULT_SECRET_SCOPES,
  generateApiKey,
  hashApiKey,
  keyPrefix,
  MAX_ACTIVE_KEYS_PER_MODE,
  ROLL_OVERLAP_SECONDS,
  RollOverlap,
} from '../domain/api-key';
import {
  ApiKeyLimitReachedException,
  ApiKeyRevokedException,
  MerchantNotApprovedException,
  MerchantNotEditableException,
  MerchantSuspendedException,
  MfaRequiredForLiveKeysException,
} from '../domain/exceptions/merchant.exceptions';
import { MerchantRole, MerchantStatus } from '../domain/merchant.enums';
import { ApiKeyEntity } from '../infrastructure/entities/api-key.entity';
import { MerchantMemberEntity } from '../infrastructure/entities/merchant-member.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import { CreateApiKeyDto, UpdateApiKeyDto } from '../interface/dto/api-key.dto';
import { ApiKeyAuthenticatorService } from './api-key-authenticator.service';
import { lockMerchant, MerchantActor } from './merchant-state';

export interface ApiKeyView {
  id: string;
  mode: ApiKeyMode;
  kind: string;
  name: string;
  // e.g. "sk_live_…a1B2" — enough to recognise it, useless to an attacker.
  displayKey: string;
  scopes: string[];
  allowedIps: string[];
  allowedOrigins: string[];
  hidePrices: boolean;
  state: 'active' | 'expiring' | 'expired' | 'revoked';
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
}

export interface CreatedApiKey {
  key: ApiKeyView;
  // The full key. Returned once, never stored, never shown again.
  secret: string;
}

// Revoked/expired keys stay listed this long, then drop off the list.
const SHOW_ENDED_FOR_DAYS = 30;

export function apiKeyView(key: ApiKeyEntity): ApiKeyView {
  const now = Date.now();
  const state: ApiKeyView['state'] = key.revokedAt
    ? 'revoked'
    : key.expiresAt && key.expiresAt.getTime() <= now
      ? 'expired'
      : key.expiresAt
        ? 'expiring'
        : 'active';
  return {
    id: key.id,
    mode: key.mode,
    kind: key.kind,
    name: key.name,
    displayKey: `${key.prefix}…${key.last4}`,
    scopes: key.kind === 'publishable' ? [] : key.scopes,
    allowedIps: key.allowedIps,
    allowedOrigins: key.allowedOrigins,
    hidePrices: key.hidePrices,
    state,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: key.lastUsedIp,
    createdAt: key.createdAt.toISOString(),
  };
}

// Dashboard key management (Developers › API keys). Live keys need an
// approved, non-suspended merchant, 2FA on both the caller and the owner,
// and a fresh step-up (plan §3.2).
@Injectable()
export class ApiKeyService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly mfa: MfaService,
    private readonly authenticator: ApiKeyAuthenticatorService,
  ) {}

  async list(merchantId: string, mode: ApiKeyMode): Promise<ApiKeyView[]> {
    const keys = await this.dataSource
      .getRepository(ApiKeyEntity)
      .createQueryBuilder('k')
      .where('k."merchantId" = :merchantId AND k.mode = :mode', {
        merchantId,
        mode,
      })
      .andWhere(
        `COALESCE(k."revokedAt", k."expiresAt", 'infinity') > now() - make_interval(days => :days)`,
        { days: SHOW_ENDED_FOR_DAYS },
      )
      .orderBy('k."createdAt"', 'DESC')
      .getMany();
    return keys.map(apiKeyView);
  }

  async create(
    actor: MerchantActor,
    dto: CreateApiKeyDto,
  ): Promise<CreatedApiKey> {
    if (dto.mode === 'live') {
      assertRecentAuth(actor);
      await this.assertCallerMfa(actor);
    }
    const created = await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      await this.assertModeAllowed(manager, merchant, dto.mode);
      await this.assertBelowLimit(manager, merchant.id, dto.mode);
      const result = await this.insertKey(manager, actor, {
        mode: dto.mode,
        kind: dto.kind,
        name: dto.name,
        scopes: dto.scopes ?? [...DEFAULT_SECRET_SCOPES],
        allowedIps: dto.allowedIps ?? [],
        allowedOrigins: dto.allowedOrigins ?? [],
        hidePrices: dto.hidePrices ?? false,
        rolledFromKeyId: null,
      });
      await this.record(
        manager,
        actor,
        'merchant.api_key_created',
        result.entity,
      );
      return result;
    });
    return { key: apiKeyView(created.entity), secret: created.secret };
  }

  async update(
    actor: MerchantActor,
    keyId: string,
    dto: UpdateApiKeyDto,
  ): Promise<ApiKeyView> {
    const updated = await this.dataSource.transaction(async (manager) => {
      const key = await this.keyOf(manager, actor.merchantId, keyId, true);
      if (key.mode === 'live') {
        assertRecentAuth(actor);
      }
      this.assertUsable(key);
      const before = this.settings(key);
      if (dto.name !== undefined) key.name = dto.name;
      if (key.kind === 'secret') {
        if (dto.scopes !== undefined) key.scopes = dto.scopes;
        if (dto.allowedIps !== undefined) key.allowedIps = dto.allowedIps;
      } else {
        if (dto.allowedOrigins !== undefined)
          key.allowedOrigins = dto.allowedOrigins;
        if (dto.hidePrices !== undefined) key.hidePrices = dto.hidePrices;
      }
      await manager.save(key);
      await this.record(
        manager,
        actor,
        'merchant.api_key_updated',
        key,
        before,
      );
      return key;
    });
    await this.authenticator.forget(updated.keyHash);
    return apiKeyView(updated);
  }

  // New key with the same settings; the old one keeps working for the
  // chosen overlap so the merchant can deploy without downtime.
  async roll(
    actor: MerchantActor,
    keyId: string,
    expireOldIn: RollOverlap,
  ): Promise<CreatedApiKey> {
    let oldHash = '';
    const created = await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      const old = await this.keyOf(manager, merchant.id, keyId, true);
      this.assertUsable(old);
      if (old.mode === 'live') {
        assertRecentAuth(actor);
        await this.assertCallerMfa(actor);
      }
      await this.assertModeAllowed(manager, merchant, old.mode);

      const overlap = ROLL_OVERLAP_SECONDS[expireOldIn];
      if (overlap === 0) {
        old.revokedAt = new Date();
        old.revokedByUserId = actor.userId;
      } else {
        const until = new Date(Date.now() + overlap * 1000);
        // Never extend a key that was already due to expire sooner.
        old.expiresAt =
          old.expiresAt && old.expiresAt < until ? old.expiresAt : until;
      }
      await manager.save(old);
      oldHash = old.keyHash;

      const result = await this.insertKey(manager, actor, {
        mode: old.mode,
        kind: old.kind,
        name: old.name,
        scopes: old.scopes,
        allowedIps: old.allowedIps,
        allowedOrigins: old.allowedOrigins,
        hidePrices: old.hidePrices,
        rolledFromKeyId: old.id,
      });
      await this.record(
        manager,
        actor,
        'merchant.api_key_rolled',
        result.entity,
        {
          rolledFromKeyId: old.id,
          oldKeyExpiresAt: old.expiresAt?.toISOString() ?? null,
          oldKeyRevoked: old.revokedAt !== null,
        },
      );
      return result;
    });
    await this.authenticator.forget(oldHash);
    return { key: apiKeyView(created.entity), secret: created.secret };
  }

  // Revoking is always safe, so no step-up: a leaked key must be killable
  // in one click.
  async revoke(actor: MerchantActor, keyId: string): Promise<ApiKeyView> {
    const key = await this.dataSource.transaction(async (manager) => {
      const found = await this.keyOf(manager, actor.merchantId, keyId, true);
      if (!found.revokedAt) {
        found.revokedAt = new Date();
        found.revokedByUserId = actor.userId;
        await manager.save(found);
        await this.record(manager, actor, 'merchant.api_key_revoked', found);
      }
      return found;
    });
    await this.authenticator.forget(key.keyHash);
    return apiKeyView(key);
  }

  // Emergency: every unrevoked key of this mode, at once.
  async revokeAll(
    actor: MerchantActor,
    mode: ApiKeyMode,
  ): Promise<{ revoked: number }> {
    const keys = await this.dataSource.transaction(async (manager) => {
      const active = await manager.find(ApiKeyEntity, {
        where: { merchantId: actor.merchantId, mode, revokedAt: IsNull() },
      });
      const now = new Date();
      for (const key of active) {
        key.revokedAt = now;
        key.revokedByUserId = actor.userId;
      }
      await manager.save(active);
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'merchant.api_keys_revoked_all',
          merchantId: actor.merchantId,
          target: { type: 'merchant', id: actor.merchantId },
          metadata: { mode, keyIds: active.map((k) => k.id) },
          context: actor.context,
        },
        manager,
      );
      return active;
    });
    await Promise.all(
      keys.map((key) => this.authenticator.forget(key.keyHash)),
    );
    return { revoked: keys.length };
  }

  private async insertKey(
    manager: EntityManager,
    actor: MerchantActor,
    fields: Pick<
      ApiKeyEntity,
      | 'mode'
      | 'kind'
      | 'name'
      | 'scopes'
      | 'allowedIps'
      | 'allowedOrigins'
      | 'hidePrices'
      | 'rolledFromKeyId'
    >,
  ): Promise<{ entity: ApiKeyEntity; secret: string }> {
    const secret = generateApiKey(fields.kind, fields.mode);
    const publishable = fields.kind === 'publishable';
    const entity = await manager.save(
      manager.create(ApiKeyEntity, {
        merchantId: actor.merchantId,
        mode: fields.mode,
        kind: fields.kind,
        name: fields.name,
        prefix: keyPrefix(fields.kind, fields.mode),
        last4: secret.slice(-4),
        keyHash: hashApiKey(secret),
        scopes: publishable ? [] : fields.scopes,
        allowedIps: publishable ? [] : fields.allowedIps,
        allowedOrigins: publishable ? fields.allowedOrigins : [],
        hidePrices: publishable ? fields.hidePrices : false,
        createdByUserId: actor.userId,
        rolledFromKeyId: fields.rolledFromKeyId,
      }),
    );
    return { entity, secret };
  }

  private async assertModeAllowed(
    manager: EntityManager,
    merchant: MerchantEntity,
    mode: ApiKeyMode,
  ): Promise<void> {
    if (
      merchant.status === MerchantStatus.CLOSED ||
      merchant.status === MerchantStatus.REJECTED
    ) {
      throw new MerchantNotEditableException(merchant.status);
    }
    if (mode === 'test') {
      return;
    }
    if (merchant.status === MerchantStatus.SUSPENDED) {
      throw new MerchantSuspendedException();
    }
    if (merchant.status !== MerchantStatus.APPROVED) {
      throw new MerchantNotApprovedException();
    }
    const owner = await manager.findOneBy(MerchantMemberEntity, {
      merchantId: merchant.id,
      role: MerchantRole.OWNER,
    });
    if (!owner || !(await this.mfa.flags(owner.userId)).enabled) {
      throw new MfaRequiredForLiveKeysException('owner');
    }
  }

  private async assertCallerMfa(actor: MerchantActor): Promise<void> {
    if (!(await this.mfa.flags(actor.userId)).enabled) {
      throw new MfaRequiredForLiveKeysException('you');
    }
  }

  private async assertBelowLimit(
    manager: EntityManager,
    merchantId: string,
    mode: ApiKeyMode,
  ): Promise<void> {
    const [{ count }] = await manager.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM api_keys
        WHERE "merchantId" = $1 AND mode = $2 AND "revokedAt" IS NULL
          AND ("expiresAt" IS NULL OR "expiresAt" > now())`,
      [merchantId, mode],
    );
    if (count >= MAX_ACTIVE_KEYS_PER_MODE) {
      throw new ApiKeyLimitReachedException(MAX_ACTIVE_KEYS_PER_MODE);
    }
  }

  private assertUsable(key: ApiKeyEntity): void {
    if (
      key.revokedAt ||
      (key.expiresAt && key.expiresAt.getTime() <= Date.now())
    ) {
      throw new ApiKeyRevokedException();
    }
  }

  private async keyOf(
    manager: EntityManager,
    merchantId: string,
    keyId: string,
    lock = false,
  ): Promise<ApiKeyEntity> {
    const query = manager
      .getRepository(ApiKeyEntity)
      .createQueryBuilder('k')
      .where('k.id = :keyId AND k."merchantId" = :merchantId', {
        keyId,
        merchantId,
      });
    if (lock) {
      query.setLock('pessimistic_write');
    }
    const key = await query.getOne();
    if (!key) {
      throw new EntityNotFoundException('API key', keyId);
    }
    return key;
  }

  private settings(key: ApiKeyEntity): Record<string, unknown> {
    return {
      name: key.name,
      scopes: key.scopes,
      allowedIps: key.allowedIps,
      allowedOrigins: key.allowedOrigins,
      hidePrices: key.hidePrices,
    };
  }

  private async record(
    manager: EntityManager,
    actor: MerchantActor,
    action: string,
    key: ApiKeyEntity,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      {
        actor: { type: 'user', id: actor.userId },
        action,
        merchantId: actor.merchantId,
        target: { type: 'api_key', id: key.id },
        before: action === 'merchant.api_key_updated' ? (extra ?? null) : null,
        after: {
          mode: key.mode,
          kind: key.kind,
          displayKey: `${key.prefix}…${key.last4}`,
          ...this.settings(key),
        },
        metadata:
          action === 'merchant.api_key_updated' ? null : (extra ?? null),
        context: actor.context,
      },
      manager,
    );
  }
}
