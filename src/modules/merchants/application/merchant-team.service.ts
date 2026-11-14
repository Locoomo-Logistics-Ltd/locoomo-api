import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { isUniqueViolation } from '../../../common/database/is-unique-violation.util';
import { EntityNotFoundException } from '../../../common/exceptions';
import { UserLookupService } from '../../identity/application/user-lookup.service';
import {
  AlreadyAMerchantMemberException,
  AlreadyATeamMemberException,
  InvalidMerchantInviteException,
  InviteEmailMismatchException,
  MerchantNotEditableException,
  OwnerRoleProtectedException,
} from '../domain/exceptions/merchant.exceptions';
import { MerchantRole, MerchantStatus } from '../domain/merchant.enums';
import { MerchantInviteEntity } from '../infrastructure/entities/merchant-invite.entity';
import { MerchantMemberEntity } from '../infrastructure/entities/merchant-member.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import { MerchantContextService } from './merchant-context.service';
import { MerchantNotifierService } from './merchant-notifier.service';
import { lockMerchant, MerchantActor } from './merchant-state';

export const MERCHANT_INVITE_TTL_DAYS = 7;

export interface TeamMemberView {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  role: MerchantRole;
  joinedAt: string;
}

export interface TeamInviteView {
  id: string;
  email: string;
  role: MerchantRole;
  expiresAt: string;
  createdAt: string;
}

export interface TeamView {
  members: TeamMemberView[];
  invites: TeamInviteView[];
}

export interface InvitePreview {
  merchantName: string;
  role: MerchantRole;
  email: string;
  expiresAt: string;
}

const inviteView = (invite: MerchantInviteEntity): TeamInviteView => ({
  id: invite.id,
  email: invite.email,
  role: invite.role,
  expiresAt: invite.expiresAt.toISOString(),
  createdAt: invite.createdAt.toISOString(),
});

@Injectable()
export class MerchantTeamService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly userLookup: UserLookupService,
    private readonly contextService: MerchantContextService,
    private readonly notifier: MerchantNotifierService,
  ) {}

  async team(merchantId: string): Promise<TeamView> {
    const manager = this.dataSource.manager;
    const members = await manager.find(MerchantMemberEntity, {
      where: { merchantId },
      order: { createdAt: 'ASC' },
    });
    const contacts = new Map(
      (await this.userLookup.getContacts(members.map((m) => m.userId))).map(
        (contact) => [contact.id, contact],
      ),
    );
    const invites = await manager
      .getRepository(MerchantInviteEntity)
      .createQueryBuilder('i')
      .where('i."merchantId" = :merchantId', { merchantId })
      .andWhere('i."acceptedAt" IS NULL AND i."revokedAt" IS NULL')
      .andWhere('i."expiresAt" > now()')
      .orderBy('i."createdAt"', 'ASC')
      .getMany();
    return {
      members: members.map((member) => {
        const contact = contacts.get(member.userId);
        return {
          id: member.id,
          userId: member.userId,
          firstName: contact?.firstName ?? '',
          lastName: contact?.lastName ?? '',
          email: contact?.email ?? '',
          role: member.role,
          joinedAt: member.createdAt.toISOString(),
        };
      }),
      invites: invites.map(inviteView),
    };
  }

  async invite(
    actor: MerchantActor,
    email: string,
    role: MerchantRole,
  ): Promise<TeamInviteView> {
    const existingUserId = await this.userLookup.findIdByEmail(email);
    const rawToken = randomBytes(32).toString('base64url');
    const [inviter] = await this.userLookup.getContacts([actor.userId]);

    return this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      this.assertTeamEditable(merchant);
      if (existingUserId) {
        const onTeam = await manager.findOneBy(MerchantMemberEntity, {
          merchantId: merchant.id,
          userId: existingUserId,
        });
        if (onTeam) {
          throw new AlreadyATeamMemberException();
        }
      }
      // Re-inviting replaces the open invite (new role, fresh link).
      await manager.update(
        MerchantInviteEntity,
        {
          merchantId: merchant.id,
          email,
          acceptedAt: IsNull(),
          revokedAt: IsNull(),
        },
        { revokedAt: new Date() },
      );
      const expiresAt = new Date(
        Date.now() + MERCHANT_INVITE_TTL_DAYS * 86_400_000,
      );
      const saved = await manager.save(
        manager.create(MerchantInviteEntity, {
          merchantId: merchant.id,
          email,
          role,
          tokenHash: hashToken(rawToken),
          invitedByUserId: actor.userId,
          expiresAt,
        }),
      );
      await this.notifier.invite(
        {
          email,
          merchantName: merchant.tradingName,
          role,
          inviterName: inviter
            ? `${inviter.firstName} ${inviter.lastName}`
            : 'A teammate',
          rawToken,
          expiresAt,
        },
        manager,
      );
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'merchant.member_invited',
          merchantId: merchant.id,
          target: { type: 'merchant_invite', id: saved.id },
          after: { email, role },
          context: actor.context,
        },
        manager,
      );
      return inviteView(saved);
    });
  }

  async revokeInvite(actor: MerchantActor, inviteId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const invite = await manager.findOneBy(MerchantInviteEntity, {
        id: inviteId,
        merchantId: actor.merchantId,
        acceptedAt: IsNull(),
        revokedAt: IsNull(),
      });
      if (!invite) {
        throw new EntityNotFoundException('Invite', inviteId);
      }
      await manager.update(MerchantInviteEntity, invite.id, {
        revokedAt: new Date(),
      });
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'merchant.invite_revoked',
          merchantId: actor.merchantId,
          target: { type: 'merchant_invite', id: invite.id },
          before: { email: invite.email, role: invite.role },
          context: actor.context,
        },
        manager,
      );
    });
  }

  // Public (token holder only): what the accept screen shows before sign-in.
  async preview(rawToken: string): Promise<InvitePreview> {
    const invite = await this.openInvite(this.dataSource.manager, rawToken);
    const merchant = await this.dataSource.manager.findOneByOrFail(
      MerchantEntity,
      { id: invite.merchantId },
    );
    return {
      merchantName: merchant.tradingName,
      role: invite.role,
      email: invite.email,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  async accept(
    userId: string,
    rawToken: string,
    context: AuditRequestContext,
  ): Promise<{ merchantId: string; role: MerchantRole }> {
    const [user] = await this.userLookup.getContacts([userId]);
    if (await this.contextService.membershipFor(userId)) {
      throw new AlreadyAMerchantMemberException();
    }
    let result: { merchantId: string; role: MerchantRole };
    try {
      result = await this.dataSource.transaction(async (manager) => {
        const invite = await this.openInvite(manager, rawToken, true);
        if (!user || user.email !== invite.email) {
          throw new InviteEmailMismatchException();
        }
        const merchant = await lockMerchant(manager, invite.merchantId);
        if (merchant.status === MerchantStatus.CLOSED) {
          throw new InvalidMerchantInviteException();
        }
        const member = await manager.save(
          manager.create(MerchantMemberEntity, {
            merchantId: merchant.id,
            userId,
            role: invite.role,
            invitedByUserId: invite.invitedByUserId,
          }),
        );
        await manager.update(MerchantInviteEntity, invite.id, {
          acceptedAt: new Date(),
          acceptedByUserId: userId,
        });
        await this.audit.record(
          {
            actor: { type: 'user', id: userId },
            action: 'merchant.member_joined',
            merchantId: merchant.id,
            target: { type: 'merchant_member', id: member.id },
            after: { role: member.role },
            metadata: { inviteId: invite.id },
            context,
          },
          manager,
        );
        await this.notifier.teamChanged(
          merchant,
          {
            subject: `${user.firstName} ${user.lastName} joined ${merchant.tradingName}`,
            text: `${user.firstName} ${user.lastName} (${user.email}) accepted your invitation and joined the team as ${member.role}.`,
          },
          manager,
        );
        return { merchantId: merchant.id, role: member.role };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AlreadyAMerchantMemberException();
      }
      throw error;
    }
    await this.contextService.bust(userId);
    return result;
  }

  async changeRole(
    actor: MerchantActor,
    memberId: string,
    role: MerchantRole,
  ): Promise<TeamMemberView> {
    const member = await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      this.assertTeamEditable(merchant);
      const target = await this.memberOf(manager, merchant.id, memberId);
      if (target.role === MerchantRole.OWNER) {
        throw new OwnerRoleProtectedException();
      }
      const before = target.role;
      target.role = role;
      await manager.save(target);
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'merchant.member_role_changed',
          merchantId: merchant.id,
          target: { type: 'merchant_member', id: target.id },
          before: { role: before },
          after: { role },
          context: actor.context,
        },
        manager,
      );
      return target;
    });
    await this.contextService.bust(member.userId);
    const [contact] = await this.userLookup.getContacts([member.userId]);
    return {
      id: member.id,
      userId: member.userId,
      firstName: contact?.firstName ?? '',
      lastName: contact?.lastName ?? '',
      email: contact?.email ?? '',
      role: member.role,
      joinedAt: member.createdAt.toISOString(),
    };
  }

  // Removing someone else (team.manage), or leaving yourself (anyone but
  // the owner).
  async removeMember(actor: MerchantActor, memberId: string): Promise<void> {
    const removedUserId = await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      const target = await this.memberOf(manager, merchant.id, memberId);
      if (target.role === MerchantRole.OWNER) {
        throw new OwnerRoleProtectedException();
      }
      await manager.delete(MerchantMemberEntity, target.id);
      const leaving = target.userId === actor.userId;
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: leaving ? 'merchant.member_left' : 'merchant.member_removed',
          merchantId: merchant.id,
          target: { type: 'merchant_member', id: target.id },
          before: { userId: target.userId, role: target.role },
          context: actor.context,
        },
        manager,
      );
      return target.userId;
    });
    await this.contextService.bust(removedUserId);
  }

  async transferOwnership(
    actor: MerchantActor,
    newOwnerMemberId: string,
  ): Promise<void> {
    const affected = await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      this.assertTeamEditable(merchant);
      const current = await this.memberOf(manager, merchant.id, actor.memberId);
      const next = await this.memberOf(manager, merchant.id, newOwnerMemberId);
      if (current.role !== MerchantRole.OWNER || next.id === current.id) {
        throw new OwnerRoleProtectedException();
      }
      // Demote first: the one-owner index would refuse two owners.
      await manager.update(MerchantMemberEntity, current.id, {
        role: MerchantRole.ADMIN,
      });
      await manager.update(MerchantMemberEntity, next.id, {
        role: MerchantRole.OWNER,
      });
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'merchant.ownership_transferred',
          merchantId: merchant.id,
          target: { type: 'merchant_member', id: next.id },
          before: { ownerUserId: current.userId },
          after: { ownerUserId: next.userId },
          context: actor.context,
        },
        manager,
      );
      const contacts = await this.userLookup.getContacts([next.userId]);
      const newOwner = contacts[0];
      await this.notifier.teamChanged(
        merchant,
        {
          subject: `${merchant.tradingName} has a new owner`,
          text: `Ownership of ${merchant.tradingName} was transferred to ${newOwner ? `${newOwner.firstName} ${newOwner.lastName} (${newOwner.email})` : 'another team member'}. The previous owner is now an admin.`,
        },
        manager,
      );
      return [current.userId, next.userId];
    });
    await this.contextService.bust(...affected);
  }

  private async openInvite(
    manager: EntityManager,
    rawToken: string,
    lock = false,
  ): Promise<MerchantInviteEntity> {
    const query = manager
      .getRepository(MerchantInviteEntity)
      .createQueryBuilder('i')
      .where('i."tokenHash" = :hash', { hash: hashToken(rawToken) });
    if (lock) {
      query.setLock('pessimistic_write');
    }
    const invite = await query.getOne();
    if (
      !invite ||
      invite.acceptedAt ||
      invite.revokedAt ||
      invite.expiresAt.getTime() <= Date.now()
    ) {
      throw new InvalidMerchantInviteException();
    }
    return invite;
  }

  private async memberOf(
    manager: EntityManager,
    merchantId: string,
    memberId: string,
  ): Promise<MerchantMemberEntity> {
    const member = await manager.findOneBy(MerchantMemberEntity, {
      id: memberId,
      merchantId,
    });
    if (!member) {
      throw new EntityNotFoundException('Team member', memberId);
    }
    return member;
  }

  private assertTeamEditable(merchant: MerchantEntity): void {
    if (
      merchant.status === MerchantStatus.CLOSED ||
      merchant.status === MerchantStatus.REJECTED
    ) {
      throw new MerchantNotEditableException(merchant.status);
    }
  }
}
