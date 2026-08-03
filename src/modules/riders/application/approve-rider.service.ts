import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { ActivateUserService } from '../../identity/application/activate-user.service';
import { RiderStatus } from '../domain/rider-status.enum';
import { CloudinaryService } from '../infrastructure/cloudinary.service';
import { RiderProfileEntity } from '../infrastructure/entities/rider-profile.entity';
import { RiderVerificationDocumentEntity } from '../infrastructure/entities/rider-verification-document.entity';
import { RiderResponseDto } from '../interface/dto/rider-response.dto';
import { toRiderResponseDto } from './rider-response.mapper';

@Injectable()
export class ApproveRiderService {
  constructor(
    @InjectRepository(RiderProfileEntity)
    private readonly profiles: Repository<RiderProfileEntity>,
    @InjectRepository(RiderVerificationDocumentEntity)
    private readonly documents: Repository<RiderVerificationDocumentEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly activateUserService: ActivateUserService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async approve(profileId: string): Promise<RiderResponseDto> {
    const profile = await this.profiles.findOneBy({ id: profileId });
    if (!profile) {
      throw new EntityNotFoundException('RiderProfile', profileId);
    }

    const updated = await this.dataSource.transaction(async (manager) => {
      await this.activateUserService.activate(profile.userId, manager);
      await manager.update(RiderProfileEntity, profile.id, {
        status: RiderStatus.ACTIVE,
      });
      return manager.findOneByOrFail(RiderProfileEntity, { id: profile.id });
    });

    const docs = await this.documents.findBy({ riderProfileId: profile.id });
    return toRiderResponseDto(updated, docs, this.cloudinaryService);
  }
}
