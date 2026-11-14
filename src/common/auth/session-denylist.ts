import { Injectable } from '@nestjs/common';
import { SharedCache } from '../redis/shared-cache';

// Access tokens are stateless and live 15 minutes. When a session is
// revoked (sign out of a device, sign out everywhere, password reset,
// suspension) its id goes on this list for that long, and AuthGuard rejects
// any access token carrying it — so revocation is immediate, not "within
// 15 minutes". Shared across instances via Redis when configured.
export const SESSION_DENYLIST_TTL_SECONDS = 15 * 60;

@Injectable()
export class SessionDenylist {
  constructor(private readonly cache: SharedCache) {}

  async revoke(sessionIds: string[]): Promise<void> {
    await Promise.all(
      [...new Set(sessionIds)].map((sid) =>
        this.cache.set(
          `revoked-session:${sid}`,
          1,
          SESSION_DENYLIST_TTL_SECONDS,
        ),
      ),
    );
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    return (await this.cache.get<number>(`revoked-session:${sessionId}`)) === 1;
  }
}
