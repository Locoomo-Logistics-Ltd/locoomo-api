import { createHash, randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { toDataURL } from 'qrcode';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { createSecretBox } from '../../../common/crypto/data-encryption-key';
import { SecretBox } from '../../../common/crypto/secret-box';
import { EntityNotFoundException } from '../../../common/exceptions';
import { SharedCache } from '../../../common/redis/shared-cache';
import { Env } from '../../../config/env.validation';
import { renderEmail } from '../../notifications/application/email-template';
import { OutboxService } from '../../notifications/application/outbox.service';
import {
  MFA_CHALLENGE_MAX_ATTEMPTS,
  MFA_CHALLENGE_TTL_SECONDS,
  MFA_ENROLLMENT_GRACE_DAYS,
  MFA_RECOVERY_CODE_COUNT,
  TOTP_ISSUER,
} from '../domain/mfa.constants';
import {
  InvalidMfaChallengeException,
  InvalidMfaCodeException,
  MfaAlreadyEnabledException,
  MfaNotEnabledException,
  MfaRequiredForRoleException,
  MfaSetupNotStartedException,
} from '../domain/exceptions/mfa.exceptions';
import {
  base32Encode,
  generateTotpSecret,
  totpUri,
  verifyTotp,
} from '../domain/totp';
import { AccountFlagsService } from './account-flags.service';
import { MfaFactorEntity } from '../infrastructure/entities/mfa-factor.entity';
import { MfaRecoveryCodeEntity } from '../infrastructure/entities/mfa-recovery-code.entity';
import { UserEntity } from '../infrastructure/entities/user.entity';

export interface MfaStatus {
  enabled: boolean;
  confirmedAt: Date | null;
  recoveryCodesRemaining: number;
  // Whether this account must have 2FA (admins today; merchant owners
  // before live keys in M2).
  required: boolean;
  // When `required` and not yet enabled: after this, protected routes
  // answer 403 MFA_ENROLLMENT_REQUIRED.
  enrollmentDeadline: Date | null;
}

export interface MfaSetup {
  // Base32 secret for manual entry ("can't scan?").
  secret: string;
  otpauthUrl: string;
  // PNG data URL of the otpauth QR code — render with <img src=…>.
  qrDataUrl: string;
}

export type SecondFactor =
  | { code: string; recoveryCode?: undefined }
  | { recoveryCode: string; code?: undefined };

interface ChallengeState {
  userId: string;
  attempts: number;
}

const challengeKey = (token: string): string =>
  `mfa-challenge:${createHash('sha256').update(token).digest('hex')}`;

@Injectable()
export class MfaService {
  private readonly box: SecretBox;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cache: SharedCache,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly accountFlags: AccountFlagsService,
    config: ConfigService<Env, true>,
  ) {
    this.box = createSecretBox(config, 'totp-seed');
  }

  async status(userId: string): Promise<MfaStatus> {
    const user = await this.getUser(userId);
    const factor = await this.dataSource
      .getRepository(MfaFactorEntity)
      .findOneBy({ userId });
    const remaining = await this.dataSource
      .getRepository(MfaRecoveryCodeEntity)
      .countBy({ userId, usedAt: IsNull() });
    const enabled = !!factor?.confirmedAt;
    return {
      enabled,
      confirmedAt: factor?.confirmedAt ?? null,
      recoveryCodesRemaining: enabled ? remaining : 0,
      required: user.mfaRequiredSince !== null,
      enrollmentDeadline:
        user.mfaRequiredSince && !enabled
          ? enrollmentDeadline(user.mfaRequiredSince)
          : null,
    };
  }

  // Cheap, cached check (AccountFlagsService) — used on every login.
  async flags(
    userId: string,
  ): Promise<{ enabled: boolean; requiredSince: Date | null }> {
    const flags = await this.accountFlags.get(userId);
    return { enabled: flags.mfaEnabled, requiredSince: flags.mfaRequiredSince };
  }

  async startSetup(userId: string): Promise<MfaSetup> {
    const user = await this.getUser(userId);
    const repo = this.dataSource.getRepository(MfaFactorEntity);
    const existing = await repo.findOneBy({ userId });
    if (existing?.confirmedAt) {
      throw new MfaAlreadyEnabledException();
    }

    // Starting again replaces an unfinished enrolment (new QR code).
    const secret = generateTotpSecret();
    if (existing) {
      existing.secretSealed = this.box.seal(secret);
      existing.lastUsedStep = null;
      await repo.save(existing);
    } else {
      await repo.save(
        repo.create({ userId, secretSealed: this.box.seal(secret) }),
      );
    }

    const otpauthUrl = totpUri(secret, user.email, TOTP_ISSUER);
    return {
      secret: base32Encode(secret),
      otpauthUrl,
      qrDataUrl: await toDataURL(otpauthUrl, { margin: 1, width: 240 }),
    };
  }

  // First code from the app proves it's set up correctly; only then does
  // 2FA protect the account. Returns the recovery codes — shown once.
  async confirmSetup(
    userId: string,
    code: string,
    context: AuditRequestContext,
  ): Promise<{ recoveryCodes: string[] }> {
    const recoveryCodes = await this.dataSource.transaction(async (manager) => {
      const factor = await this.lockFactor(manager, userId);
      if (!factor) {
        throw new MfaSetupNotStartedException();
      }
      if (factor.confirmedAt) {
        throw new MfaAlreadyEnabledException();
      }
      this.acceptTotp(factor, code);
      factor.confirmedAt = new Date();
      await manager.save(factor);

      const codes = await this.replaceRecoveryCodes(manager, userId);
      await this.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'mfa.enabled',
          target: { type: 'user', id: userId },
          context,
        },
        manager,
      );
      await this.notify(manager, userId, 'Two-factor authentication is on', [
        'Two-factor authentication was just turned on for your Locoomo account. You’ll be asked for a code from your authenticator app when you sign in.',
        'If this wasn’t you, reset your password immediately and contact support.',
      ]);
      return codes;
    });
    await this.accountFlags.bust(userId);
    return { recoveryCodes };
  }

  async disable(userId: string, context: AuditRequestContext): Promise<void> {
    const user = await this.getUser(userId);
    if (user.mfaRequiredSince) {
      throw new MfaRequiredForRoleException();
    }
    await this.dataSource.transaction(async (manager) => {
      const factor = await this.lockFactor(manager, userId);
      if (!factor?.confirmedAt) {
        throw new MfaNotEnabledException();
      }
      await manager.delete(MfaFactorEntity, { userId });
      await manager.delete(MfaRecoveryCodeEntity, { userId });
      await this.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'mfa.disabled',
          target: { type: 'user', id: userId },
          context,
        },
        manager,
      );
      await this.notify(manager, userId, 'Two-factor authentication is off', [
        'Two-factor authentication was just turned off for your Locoomo account.',
        'If this wasn’t you, reset your password immediately and contact support.',
      ]);
    });
    await this.accountFlags.bust(userId);
  }

  async regenerateRecoveryCodes(
    userId: string,
    context: AuditRequestContext,
  ): Promise<{ recoveryCodes: string[] }> {
    const recoveryCodes = await this.dataSource.transaction(async (manager) => {
      const factor = await this.lockFactor(manager, userId);
      if (!factor?.confirmedAt) {
        throw new MfaNotEnabledException();
      }
      const codes = await this.replaceRecoveryCodes(manager, userId);
      await this.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'mfa.recovery_codes.regenerated',
          target: { type: 'user', id: userId },
          context,
        },
        manager,
      );
      return codes;
    });
    return { recoveryCodes };
  }

  // Throws InvalidMfaCodeException unless `factor` checks out. Locks the
  // factor row so two concurrent submissions of the same TOTP code can't
  // both succeed.
  async verifySecondFactor(
    userId: string,
    factor: SecondFactor,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const stored = await this.lockFactor(manager, userId);
      if (!stored?.confirmedAt) {
        throw new MfaNotEnabledException();
      }
      if (factor.recoveryCode !== undefined) {
        const [, used] = await manager.query<[unknown[], number]>(
          `UPDATE mfa_recovery_codes SET "usedAt" = now()
            WHERE "userId" = $1 AND "codeHash" = $2 AND "usedAt" IS NULL`,
          [userId, hashToken(normaliseRecoveryCode(factor.recoveryCode))],
        );
        if (used !== 1) {
          throw new InvalidMfaCodeException();
        }
        return;
      }
      this.acceptTotp(stored, factor.code);
      await manager.save(stored);
    });
  }

  // ── Login challenge ────────────────────────────────────────────────────

  // Password (or Google) was right and the account has 2FA: instead of a
  // session the client gets this short-lived, single-use token and must
  // present it with a code to POST /auth/mfa/verify.
  async createChallenge(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.cache.set<ChallengeState>(
      challengeKey(token),
      { userId, attempts: 0 },
      MFA_CHALLENGE_TTL_SECONDS,
    );
    return token;
  }

  // Returns the user id once the second factor checks out; the challenge is
  // then gone. Wrong codes count against it; at the limit it's burned.
  async completeChallenge(
    token: string,
    factor: SecondFactor,
  ): Promise<string> {
    const key = challengeKey(token);
    const state = await this.cache.get<ChallengeState>(key);
    if (!state || state.attempts >= MFA_CHALLENGE_MAX_ATTEMPTS) {
      throw new InvalidMfaChallengeException();
    }
    // Count the attempt before checking, so parallel guesses can't share
    // one slot.
    await this.cache.set<ChallengeState>(
      key,
      { ...state, attempts: state.attempts + 1 },
      MFA_CHALLENGE_TTL_SECONDS,
    );
    await this.verifySecondFactor(state.userId, factor);
    await this.cache.del(key);
    return state.userId;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private acceptTotp(factor: MfaFactorEntity, code: string): void {
    const secret = this.box.open(factor.secretSealed);
    const lastUsed =
      factor.lastUsedStep === null ? null : Number(factor.lastUsedStep);
    const step = verifyTotp(secret, code.replace(/\s+/g, ''), lastUsed);
    if (step === null) {
      throw new InvalidMfaCodeException();
    }
    factor.lastUsedStep = String(step);
  }

  private async replaceRecoveryCodes(
    manager: EntityManager,
    userId: string,
  ): Promise<string[]> {
    await manager.delete(MfaRecoveryCodeEntity, { userId });
    const codes = Array.from({ length: MFA_RECOVERY_CODE_COUNT }, () =>
      generateRecoveryCode(),
    );
    const repo = manager.getRepository(MfaRecoveryCodeEntity);
    await repo.save(
      codes.map((code) =>
        repo.create({
          userId,
          codeHash: hashToken(normaliseRecoveryCode(code)),
        }),
      ),
    );
    return codes;
  }

  private lockFactor(
    manager: EntityManager,
    userId: string,
  ): Promise<MfaFactorEntity | null> {
    return manager.getRepository(MfaFactorEntity).findOne({
      where: { userId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  private async getUser(userId: string): Promise<UserEntity> {
    const user = await this.dataSource
      .getRepository(UserEntity)
      .findOneBy({ id: userId });
    if (!user) {
      throw new EntityNotFoundException('User', userId);
    }
    return user;
  }

  private async notify(
    manager: EntityManager,
    userId: string,
    heading: string,
    paragraphs: string[],
  ): Promise<void> {
    const user = await manager
      .getRepository(UserEntity)
      .findOneByOrFail({ id: userId });
    const { html, text } = renderEmail({
      greetingName: user.firstName,
      heading,
      blocks: paragraphs.map((text) => ({ kind: 'paragraph' as const, text })),
    });
    await this.outbox.enqueueEmail(
      { to: user.email, subject: heading, html, text },
      manager,
    );
  }
}

export function enrollmentDeadline(requiredSince: Date): Date {
  return new Date(
    requiredSince.getTime() + MFA_ENROLLMENT_GRACE_DAYS * 86_400_000,
  );
}

// 10 base32 characters (50 bits) shown as "abcde-fghij".
function generateRecoveryCode(): string {
  const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function normaliseRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z2-7]/g, '');
}
