import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { EntityNotFoundException } from '../../../common/exceptions';
import { CloudinaryService } from '../infrastructure/cloudinary.service';
import { RiderProfileEntity } from '../infrastructure/entities/rider-profile.entity';
import { RiderVerificationDocumentEntity } from '../infrastructure/entities/rider-verification-document.entity';
import { PendingRiderResponseDto } from '../interface/dto/pending-rider-response.dto';
import { RiderResponseDto } from '../interface/dto/rider-response.dto';
import {
  toRiderDocumentResponseDtos,
  toRiderResponseDto,
} from './rider-response.mapper';

interface PendingRiderRow {
  profileId: string;
  currentEmployer: string;
  licenseNumber: string | null;
  submittedAt: Date;
  userEmail: string;
  userFirstName: string;
  userLastName: string;
}

// rider_profiles carries its own status (unlike node_memberships, which
// relies on Node.status) — no cross-module status join needed here, only
// the users join for display fields (email/name).
@Injectable()
export class RiderQueryService {
  constructor(
    @InjectRepository(RiderProfileEntity)
    private readonly profiles: Repository<RiderProfileEntity>,
    @InjectRepository(RiderVerificationDocumentEntity)
    private readonly documents: Repository<RiderVerificationDocumentEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async getMine(userId: string): Promise<RiderResponseDto> {
    const profile = await this.profiles.findOneBy({ userId });
    if (!profile) {
      throw new EntityNotFoundException('RiderProfile', userId);
    }
    const docs = await this.documents.findBy({ riderProfileId: profile.id });
    return toRiderResponseDto(profile, docs, this.cloudinaryService);
  }

  async listPending(
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<PendingRiderResponseDto>> {
    const offset = (query.page - 1) * query.limit;

    const rows = await this.dataSource.query<PendingRiderRow[]>(
      `SELECT rp.id AS "profileId", rp."currentEmployer", rp."licenseNumber",
              rp."createdAt" AS "submittedAt", u.email AS "userEmail",
              u."firstName" AS "userFirstName", u."lastName" AS "userLastName"
         FROM rider_profiles rp
         JOIN users u ON u.id = rp."userId"
        WHERE rp.status = 'pending'
        ORDER BY rp."createdAt" ASC
        LIMIT $1 OFFSET $2`,
      [query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM rider_profiles WHERE status = 'pending'`,
    );

    const profileIds = rows.map((row) => row.profileId);
    const docs =
      profileIds.length > 0
        ? await this.documents.findBy({ riderProfileId: In(profileIds) })
        : [];

    const items = rows.map((row) => {
      const dto = new PendingRiderResponseDto();
      dto.profileId = row.profileId;
      dto.userEmail = row.userEmail;
      dto.userFirstName = row.userFirstName;
      dto.userLastName = row.userLastName;
      dto.currentEmployer = row.currentEmployer;
      dto.licenseNumber = row.licenseNumber;
      dto.submittedAt = row.submittedAt;
      dto.documents = toRiderDocumentResponseDtos(
        docs.filter((doc) => doc.riderProfileId === row.profileId),
        this.cloudinaryService,
      );
      return dto;
    });

    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
