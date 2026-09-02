import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { UserRole } from '../../../common/auth/user-role.enum';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { isUniqueViolation } from '../../../common/database/is-unique-violation.util';
import { Env } from '../../../config/env.validation';
import { OutboxService } from '../../notifications/application/outbox.service';
import { EmailAlreadyRegisteredException } from '../domain/exceptions/email-already-registered.exception';
import { INVITE_TOKEN_TTL_DAYS } from '../domain/invite.constants';
import { UserStatus } from '../domain/user-status.enum';
import { InviteTokenEntity } from '../infrastructure/entities/invite-token.entity';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { InviteUserDto } from '../interface/dto/invite-user.dto';
import { UserResponseDto } from '../interface/dto/user-response.dto';

interface InviteFields {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: UserRole;
}

@Injectable()
export class InviteUserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxService: OutboxService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  // Admin-provisioning path — POST /users/invite, @Roles(ADMIN)-gated at
  // the controller (this service itself has no notion of who's calling).
  async invite(dto: InviteUserDto): Promise<UserResponseDto> {
    const email = dto.email.toLowerCase();

    const existing = await this.users.findOneBy({ email });
    if (existing) {
      throw new EmailAlreadyRegisteredException(email);
    }

    try {
      const saved = await this.dataSource.transaction((manager) =>
        this.createInvite({ ...dto, email }, manager),
      );
      return UserResponseDto.fromEntity(saved);
    } catch (error) {
      // Pre-check above handles the common case; this catches the race
      // where two invites for the same email land concurrently.
      if (isUniqueViolation(error)) {
        throw new EmailAlreadyRegisteredException(email);
      }
      throw error;
    }
  }

  // Node-owner-provisioning path — narrow export for node-operators'
  // POST /nodes/:nodeId/staff/invite (the first non-Admin-provisioning
  // invite path in this codebase). Hardcodes role: NODE_STAFF internally so
  // the caller never imports UserRole for this, same "owning module bakes
  // in the enum" template as NodesService.createPendingPortalNode. `manager`
  // is required, not optional — this only makes sense as part of the
  // caller's own transaction (creating the linked NodeMembershipEntity
  // alongside it).
  async inviteNodeStaff(
    fields: {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
    },
    manager: EntityManager,
  ): Promise<UserResponseDto> {
    const email = fields.email.toLowerCase();

    const existing = await manager.findOneBy(UserEntity, { email });
    if (existing) {
      throw new EmailAlreadyRegisteredException(email);
    }

    try {
      const saved = await this.createInvite(
        { ...fields, email, role: UserRole.NODE_STAFF },
        manager,
      );
      return UserResponseDto.fromEntity(saved);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new EmailAlreadyRegisteredException(email);
      }
      throw error;
    }
  }

  private async createInvite(
    fields: InviteFields,
    manager: EntityManager,
  ): Promise<UserEntity> {
    const rawInviteToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(
      Date.now() + INVITE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    const inviteLink = `${this.configService.get('FRONTEND_URL', { infer: true })}/accept-invite?token=${rawInviteToken}`;

    const user = manager.create(UserEntity, {
      email: fields.email,
      // Null until they follow the link and set one — never an
      // admin-set password.
      passwordHash: null,
      firstName: fields.firstName,
      lastName: fields.lastName,
      phone: fields.phone,
      role: fields.role,
      status: UserStatus.INVITED,
      consentAcceptedAt: null,
    });
    const savedUser = await manager.save(user);

    await manager.save(
      manager.create(InviteTokenEntity, {
        userId: savedUser.id,
        tokenHash: hashToken(rawInviteToken),
        expiresAt,
        usedAt: null,
      }),
    );

    await this.outboxService.enqueueEmail(
      {
        to: savedUser.email,
        subject: "You've been invited to Locoomo",
        text: `You've been invited to join Locoomo as a ${fields.role}. Set your password to get started: ${inviteLink}\n\nThis link expires in ${INVITE_TOKEN_TTL_DAYS} days.`,
        html: `<p>You've been invited to join Locoomo as a ${fields.role}.</p><p>Set your password to get started:</p><p><a href="${inviteLink}">${inviteLink}</a></p><p>This link expires in ${INVITE_TOKEN_TTL_DAYS} days.</p>`,
      },
      manager,
    );

    return savedUser;
  }
}
