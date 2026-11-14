import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SharedCache } from '../../../common/redis/shared-cache';

export interface AccountFlags {
  emailVerified: boolean;
  mfaEnabled: boolean;
  mfaRequiredSince: Date | null;
}

interface CachedFlags {
  emailVerified: boolean;
  mfaEnabled: boolean;
  mfaRequiredSince: string | null;
}

const key = (userId: string): string => `account-flags:${userId}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An id that isn't a user (deleted account, or not a UUID at all): no
// verified email, no 2FA, nothing mandatory — the most restrictive reading
// for @RequireVerifiedEmail, and no lockout for routes that don't need it.
const UNKNOWN_USER: AccountFlags = {
  emailVerified: false,
  mfaEnabled: false,
  mfaRequiredSince: null,
};
const TTL_SECONDS = 30;

// Per-request account state the guards need (verified email, 2FA) without
// a database hit on every request. Anything that changes these must call
// bust() — verify email, enable/disable 2FA, make 2FA mandatory.
@Injectable()
export class AccountFlagsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cache: SharedCache,
  ) {}

  async get(userId: string): Promise<AccountFlags> {
    if (!UUID.test(userId)) {
      return UNKNOWN_USER;
    }
    const cached = await this.cache.get<CachedFlags>(key(userId));
    if (cached) {
      return {
        ...cached,
        mfaRequiredSince: cached.mfaRequiredSince
          ? new Date(cached.mfaRequiredSince)
          : null,
      };
    }
    const [row] = await this.dataSource.query<
      {
        emailVerified: boolean;
        mfaEnabled: boolean;
        mfaRequiredSince: Date | null;
      }[]
    >(
      `SELECT (u."emailVerifiedAt" IS NOT NULL) AS "emailVerified",
              (f."confirmedAt" IS NOT NULL) AS "mfaEnabled",
              u."mfaRequiredSince"
         FROM users u
         LEFT JOIN mfa_factors f ON f."userId" = u.id
        WHERE u.id = $1`,
      [userId],
    );
    const flags: AccountFlags = {
      emailVerified: !!row?.emailVerified,
      mfaEnabled: !!row?.mfaEnabled,
      mfaRequiredSince: row?.mfaRequiredSince ?? null,
    };
    await this.cache.set<CachedFlags>(
      key(userId),
      {
        ...flags,
        mfaRequiredSince: flags.mfaRequiredSince?.toISOString() ?? null,
      },
      TTL_SECONDS,
    );
    return flags;
  }

  async bust(userId: string): Promise<void> {
    await this.cache.del(key(userId));
  }
}
