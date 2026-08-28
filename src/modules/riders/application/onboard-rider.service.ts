import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { isUniqueViolation } from '../../../common/database/is-unique-violation.util';
import { UserLookupService } from '../../identity/application/user-lookup.service';
import { RiderStatus } from '../domain/rider-status.enum';
import { InvalidVerificationDocumentException } from '../domain/exceptions/invalid-verification-document.exception';
import { ProfileIncompleteException } from '../domain/exceptions/profile-incomplete.exception';
import { RiderAlreadyOnboardedException } from '../domain/exceptions/rider-already-onboarded.exception';
import { CloudinaryService } from '../infrastructure/cloudinary.service';
import { RiderProfileEntity } from '../infrastructure/entities/rider-profile.entity';
import { RiderVerificationDocumentEntity } from '../infrastructure/entities/rider-verification-document.entity';
import { OnboardRiderDto } from '../interface/dto/onboard-rider.dto';
import { RiderResponseDto } from '../interface/dto/rider-response.dto';
import { toRiderResponseDto } from './rider-response.mapper';

@Injectable()
export class OnboardRiderService {
  constructor(
    @InjectRepository(RiderProfileEntity)
    private readonly profiles: Repository<RiderProfileEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly cloudinaryService: CloudinaryService,
    private readonly userLookupService: UserLookupService,
  ) {}

  async onboard(
    userId: string,
    dto: OnboardRiderDto,
  ): Promise<RiderResponseDto> {
    // One profile per operator, MVP — pre-check for the common case, DB
    // unique index on userId is the backstop against a concurrent
    // double-submit.
    const existing = await this.profiles.findOneBy({ userId });
    if (existing) {
      throw new RiderAlreadyOnboardedException();
    }

    // Phone is no longer collected at registration (password or Google) —
    // dispatch/physical handoffs need a real contact number, so this is the
    // hard-gate enforcement point.
    const phone = await this.userLookupService.getPhone(userId);
    if (!phone) {
      throw new ProfileIncompleteException();
    }

    // Confirms the client actually completed the signed upload rather than
    // reporting an arbitrary/stale public_id.
    const documentExists = await this.cloudinaryService.resourceExists(
      dto.cloudinaryPublicId,
    );
    if (!documentExists) {
      throw new InvalidVerificationDocumentException();
    }

    try {
      const { profile, document } = await this.dataSource.transaction(
        async (manager) => {
          const profile = await manager.save(
            manager.create(RiderProfileEntity, {
              userId,
              currentEmployer: dto.currentEmployer,
              licenseNumber: dto.licenseNumber,
              status: RiderStatus.PENDING,
            }),
          );
          const document = await manager.save(
            manager.create(RiderVerificationDocumentEntity, {
              riderProfileId: profile.id,
              documentType: dto.documentType,
              cloudinaryPublicId: dto.cloudinaryPublicId,
            }),
          );
          return { profile, document };
        },
      );

      return toRiderResponseDto(profile, [document], this.cloudinaryService);
    } catch (error) {
      // Pre-check above handles the common case; this catches the race
      // where two onboarding requests for the same rider land concurrently.
      if (isUniqueViolation(error)) {
        throw new RiderAlreadyOnboardedException();
      }
      throw error;
    }
  }
}
