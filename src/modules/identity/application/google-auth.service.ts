import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UserRole } from '../../../common/auth/user-role.enum';
import { isUniqueViolation } from '../../../common/database/is-unique-violation.util';
import { AccountSuspendedException } from '../domain/exceptions/account-suspended.exception';
import { ConsentRequiredException } from '../domain/exceptions/consent-required.exception';
import { EmailAlreadyRegisteredException } from '../domain/exceptions/email-already-registered.exception';
import { InvalidGoogleTokenException } from '../domain/exceptions/invalid-google-token.exception';
import { UserStatus } from '../domain/user-status.enum';
import {
  GoogleIdentity,
  GoogleIdTokenVerifier,
} from '../infrastructure/google-id-token-verifier';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { GoogleAuthDto } from '../interface/dto/google-auth.dto';
import { LoginResult } from './login-user.service';
import { TokenIssuanceService } from './token-issuance.service';

@Injectable()
export class GoogleAuthService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly googleIdTokenVerifier: GoogleIdTokenVerifier,
    private readonly tokenIssuanceService: TokenIssuanceService,
  ) {}

  async authenticate(dto: GoogleAuthDto): Promise<LoginResult> {
    const identity = await this.googleIdTokenVerifier.verify(dto.idToken);
    if (!identity || !identity.emailVerified) {
      throw new InvalidGoogleTokenException();
    }

    const existing = await this.users.findOneBy({ googleId: identity.sub });
    if (existing) {
      return this.login(existing);
    }

    const email = identity.email.toLowerCase();
    const emailOwner = await this.users.findOneBy({ email });
    if (emailOwner) {
      // No auto-linking, deliberately — a verified email matching an
      // existing (password-based, invited, ...) account does not log the
      // caller into it. They're told to log in with their password instead.
      throw new EmailAlreadyRegisteredException(email);
    }

    return this.signUp(dto, identity, email);
  }

  private async login(user: UserEntity): Promise<LoginResult> {
    if (user.status === UserStatus.SUSPENDED) {
      throw new AccountSuspendedException();
    }
    const session = await this.tokenIssuanceService.issueSession(user);
    return { user, session };
  }

  private async signUp(
    dto: GoogleAuthDto,
    identity: GoogleIdentity,
    email: string,
  ): Promise<LoginResult> {
    if (dto.consentAccepted !== true) {
      throw new ConsentRequiredException();
    }

    const { firstName, lastName } = this.resolveName(identity);
    const role = dto.role ?? UserRole.CONSUMER;
    // Same derivation RegisterUserService uses: Consumer is active
    // immediately, NodeOperator/Rider land in pending_review until they
    // complete their module's onboarding step and an Admin approves it.
    const status =
      role === UserRole.NODE_OPERATOR || role === UserRole.RIDER
        ? UserStatus.PENDING_REVIEW
        : UserStatus.ACTIVE;

    try {
      const saved = await this.dataSource.transaction(async (manager) => {
        const user = manager.create(UserEntity, {
          email,
          passwordHash: null,
          firstName,
          lastName,
          phone: null,
          googleId: identity.sub,
          role,
          status,
          consentAcceptedAt: new Date(),
          // Google's email_verified: true is itself proof of ownership —
          // same reasoning ConfirmInviteService applies to invited accounts
          // completing their invite link. Skips the separate
          // email-verification-token flow entirely.
          emailVerifiedAt: new Date(),
        });
        return manager.save(user);
      });

      const session = await this.tokenIssuanceService.issueSession(saved);
      return { user: saved, session };
    } catch (error) {
      // Pre-check above handles the common case; this catches the race
      // where two requests for the same email (or, vanishingly unlikely,
      // the same Google account) land concurrently.
      if (isUniqueViolation(error)) {
        throw new EmailAlreadyRegisteredException(email);
      }
      throw error;
    }
  }

  private resolveName(identity: GoogleIdentity): {
    firstName: string;
    lastName: string;
  } {
    if (identity.givenName && identity.familyName) {
      return { firstName: identity.givenName, lastName: identity.familyName };
    }
    if (identity.name) {
      const parts = identity.name.trim().split(/\s+/);
      if (parts.length >= 2) {
        return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
      }
    }
    // Nothing usable to populate the NOT NULL firstName/lastName columns —
    // reject rather than writing blank names.
    throw new InvalidGoogleTokenException();
  }
}
