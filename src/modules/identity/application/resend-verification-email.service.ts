import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { EntityNotFoundException } from '../../../common/exceptions';
import { Env } from '../../../config/env.validation';
import { renderEmail } from '../../notifications/application/email-template';
import { OutboxService } from '../../notifications/application/outbox.service';
import { EMAIL_VERIFICATION_TOKEN_TTL_HOURS } from '../domain/email-verification.constants';
import { EmailAlreadyVerifiedException } from '../domain/exceptions/mfa.exceptions';
import { EmailVerificationTokenEntity } from '../infrastructure/entities/email-verification-token.entity';
import { UserEntity } from '../infrastructure/entities/user.entity';

// Issues a fresh verification link, invalidating any earlier unused ones so
// only the newest email works. Used by resend now; merchant routes require
// a verified email, so users who lost the first email need this.
@Injectable()
export class ResendVerificationEmailService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async resend(userId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const user = await manager
        .getRepository(UserEntity)
        .findOneBy({ id: userId });
      if (!user) {
        throw new EntityNotFoundException('User', userId);
      }
      if (user.emailVerifiedAt) {
        throw new EmailAlreadyVerifiedException();
      }
      await manager.update(
        EmailVerificationTokenEntity,
        { userId, usedAt: IsNull() },
        { usedAt: new Date() },
      );
      await this.issue(manager, user);
    });
  }

  private async issue(manager: EntityManager, user: UserEntity): Promise<void> {
    const rawToken = randomBytes(32).toString('hex');
    await manager.save(
      manager.create(EmailVerificationTokenEntity, {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(
          Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_HOURS * 3_600_000,
        ),
        usedAt: null,
      }),
    );
    const link = `${this.config.get('FRONTEND_URL', { infer: true })}/verify-email?token=${rawToken}`;
    const { html, text } = renderEmail({
      greetingName: user.firstName,
      heading: 'Verify your email',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Confirm this is your email address to finish setting up your Locoomo account.',
        },
        { kind: 'button', label: 'Verify email', url: link },
        {
          kind: 'paragraph',
          text: `This link expires in ${EMAIL_VERIFICATION_TOKEN_TTL_HOURS} hours. Earlier verification links no longer work.`,
        },
      ],
      footnote:
        'If you didn’t create a Locoomo account, you can ignore this email.',
    });
    await this.outbox.enqueueEmail(
      { to: user.email, subject: 'Verify your Locoomo email', html, text },
      manager,
    );
  }
}
