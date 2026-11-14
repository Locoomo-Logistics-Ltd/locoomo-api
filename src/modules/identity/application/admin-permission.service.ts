import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  AdminPermission,
  hasAdminPermission,
} from '../../../common/auth/admin-permission.enum';
import { UserRole } from '../../../common/auth/user-role.enum';
import {
  AuditActor,
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { EntityNotFoundException } from '../../../common/exceptions';
import { SharedCache } from '../../../common/redis/shared-cache';
import { UserStatus } from '../domain/user-status.enum';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { LastSuperAdminException } from '../domain/exceptions/last-super-admin.exception';

// Short enough that a revoked permission stops working within seconds even
// without the explicit cache bust below (which covers this instance and,
// with Redis, every instance immediately).
const CACHE_TTL_SECONDS = 30;
const cacheKey = (userId: string): string => `admin-perms:${userId}`;

interface CachedAdmin {
  isActiveAdmin: boolean;
  permissions: string[];
}

export interface AdminSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
  adminPermissions: string[];
}

@Injectable()
export class AdminPermissionService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly cache: SharedCache,
    private readonly audit: AuditService,
  ) {}

  async hasAny(
    userId: string,
    anyOf: readonly AdminPermission[],
  ): Promise<boolean> {
    const admin = await this.load(userId);
    if (!admin.isActiveAdmin) {
      return false;
    }
    return anyOf.some((permission) =>
      hasAdminPermission(admin.permissions, permission),
    );
  }

  async list(): Promise<AdminSummary[]> {
    const admins = await this.users.find({
      where: { role: UserRole.ADMIN },
      order: { createdAt: 'ASC' },
    });
    return admins.map((admin) => ({
      id: admin.id,
      email: admin.email,
      firstName: admin.firstName,
      lastName: admin.lastName,
      status: admin.status,
      adminPermissions: admin.adminPermissions,
    }));
  }

  // Replaces the target admin's permission set. Guards against the one
  // mistake that can't be fixed from the API: removing the last active
  // super admin (nobody could ever grant permissions again).
  async setPermissions(
    targetUserId: string,
    permissions: AdminPermission[],
    actor: AuditActor,
    context: AuditRequestContext,
  ): Promise<AdminSummary> {
    const unique = [...new Set(permissions)].sort();

    const updated = await this.users.manager.transaction(async (manager) => {
      const target = await this.lockAdmin(manager, targetUserId);
      const before = [...target.adminPermissions];

      const losingSuper =
        before.includes(AdminPermission.SUPER) &&
        !unique.includes(AdminPermission.SUPER);
      if (losingSuper) {
        // Serialise concurrent demotions so two supers can't demote each
        // other at the same moment and leave none.
        await manager.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('admin-super-guard', 0))`,
        );
        const [{ count }] = await manager.query<{ count: string }[]>(
          `SELECT COUNT(*) AS count FROM users
            WHERE role = $1 AND status = $2 AND $3 = ANY("adminPermissions") AND id <> $4`,
          [UserRole.ADMIN, UserStatus.ACTIVE, AdminPermission.SUPER, target.id],
        );
        if (Number(count) === 0) {
          throw new LastSuperAdminException();
        }
      }

      target.adminPermissions = unique;
      await manager.save(target);
      await this.audit.record(
        {
          actor,
          action: 'admin.permissions.updated',
          target: { type: 'user', id: target.id },
          before: { adminPermissions: before },
          after: { adminPermissions: unique },
          context,
        },
        manager,
      );
      return target;
    });

    await this.cache.del(cacheKey(targetUserId));
    return {
      id: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      status: updated.status,
      adminPermissions: updated.adminPermissions,
    };
  }

  private async lockAdmin(
    manager: EntityManager,
    userId: string,
  ): Promise<UserEntity> {
    const user = await manager.getRepository(UserEntity).findOne({
      where: { id: userId, role: UserRole.ADMIN },
      lock: { mode: 'pessimistic_write' },
    });
    if (!user) {
      throw new EntityNotFoundException('Admin', userId);
    }
    return user;
  }

  private async load(userId: string): Promise<CachedAdmin> {
    const cached = await this.cache.get<CachedAdmin>(cacheKey(userId));
    if (cached) {
      return cached;
    }
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, role: true, status: true, adminPermissions: true },
    });
    const value: CachedAdmin = {
      isActiveAdmin:
        !!user &&
        user.role === UserRole.ADMIN &&
        user.status === UserStatus.ACTIVE,
      permissions: user?.adminPermissions ?? [],
    };
    await this.cache.set(cacheKey(userId), value, CACHE_TTL_SECONDS);
    return value;
  }
}
