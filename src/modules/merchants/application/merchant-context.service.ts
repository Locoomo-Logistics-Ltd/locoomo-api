import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SharedCache } from '../../../common/redis/shared-cache';
import { MerchantRole } from '../domain/merchant.enums';
import { MerchantMemberEntity } from '../infrastructure/entities/merchant-member.entity';

export interface MerchantMembership {
  merchantId: string;
  memberId: string;
  role: MerchantRole;
}

const key = (userId: string): string => `merchant-membership:${userId}`;
const TTL_SECONDS = 30;

// "Which merchant is this user on, with what role?" — asked on every
// merchant request, so cached briefly (Redis when configured, so a role
// change or removal applies on every instance at once). Anything that
// changes a membership must call bust() for that user after committing.
@Injectable()
export class MerchantContextService {
  constructor(
    @InjectRepository(MerchantMemberEntity)
    private readonly members: Repository<MerchantMemberEntity>,
    private readonly cache: SharedCache,
  ) {}

  async membershipFor(userId: string): Promise<MerchantMembership | null> {
    const cached = await this.cache.get<{ m: MerchantMembership | null }>(
      key(userId),
    );
    if (cached) {
      return cached.m;
    }
    const member = await this.members.findOneBy({ userId });
    const membership = member
      ? {
          merchantId: member.merchantId,
          memberId: member.id,
          role: member.role,
        }
      : null;
    await this.cache.set(key(userId), { m: membership }, TTL_SECONDS);
    return membership;
  }

  async bust(...userIds: string[]): Promise<void> {
    await Promise.all(userIds.map((userId) => this.cache.del(key(userId))));
  }
}
