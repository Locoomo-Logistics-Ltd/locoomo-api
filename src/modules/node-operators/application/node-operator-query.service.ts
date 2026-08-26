import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { EntityNotFoundException } from '../../../common/exceptions';
import { NodeOperatorResponseDto } from '../interface/dto/node-operator-response.dto';
import { PendingNodeOperatorResponseDto } from '../interface/dto/pending-node-operator-response.dto';

// The node.* columns are selected unaliased so a row's shape matches
// NodeEntity's field names exactly — it can be passed straight to
// NodeResponseDto.fromEntity() with no manual remapping.
export interface NodeOperatorProfileRow {
  profileId: string;
  submittedAt: Date;
  payoutBankCode: string | null;
  payoutBankName: string | null;
  payoutAccountNumber: string | null;
  payoutAccountName: string | null;
  payoutAccountVerifiedAt: Date | null;
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  country: string;
  latitude: number;
  longitude: number;
  capacity: number;
  status: string;
  onboardingType: string;
  operatingHours: string | null;
  createdAt: Date;
}

export interface PendingNodeOperatorRow extends NodeOperatorProfileRow {
  userEmail: string;
  userFirstName: string;
  userLastName: string;
}

const NODE_OPERATOR_PROFILE_COLUMNS = `
  p.id AS "profileId",
  p."createdAt" AS "submittedAt",
  p."payoutBankCode", p."payoutBankName", p."payoutAccountNumber",
  p."payoutAccountName", p."payoutAccountVerifiedAt",
  n.id, n.name, n.address, n.city, n.state, n.country, n.latitude, n.longitude,
  n.capacity, n.status, n."onboardingType", n."operatingHours", n."createdAt"`;

// `node-operators` has no TypeORM relation to UserEntity/NodeEntity (see the
// entity comment — a cross-module `@ManyToOne` would need to import their
// classes, which the module-boundary rule forbids), so read-side joins are
// raw SQL against the table names directly — same reasoning nodes.service.ts
// already applies to its own proximity query.
@Injectable()
export class NodeOperatorQueryService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async getMine(userId: string): Promise<NodeOperatorResponseDto> {
    const rows = await this.dataSource.query<NodeOperatorProfileRow[]>(
      `SELECT${NODE_OPERATOR_PROFILE_COLUMNS}
         FROM node_operator_profiles p
         JOIN nodes n ON n.id = p."nodeId"
        WHERE p."userId" = $1`,
      [userId],
    );

    if (rows.length === 0) {
      throw new EntityNotFoundException('NodeOperatorProfile', userId);
    }

    return NodeOperatorResponseDto.fromRow(rows[0]);
  }

  // Narrow export for handoffs — every Node-operator-facing scan/confirm
  // step needs "which Node does this authenticated operator run" to scope
  // its own reads/writes to that Node only. Plain uuid lookup, not the
  // Node-joined getMine() above (callers don't need the full Node view,
  // just the id).
  async getNodeIdForUser(userId: string): Promise<string> {
    const rows = await this.dataSource.query<{ nodeId: string }[]>(
      `SELECT "nodeId" FROM node_operator_profiles WHERE "userId" = $1`,
      [userId],
    );
    const profile = rows[0];
    if (!profile) {
      throw new EntityNotFoundException('NodeOperatorProfile', userId);
    }
    return profile.nodeId;
  }

  async listPending(
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<PendingNodeOperatorResponseDto>> {
    const offset = (query.page - 1) * query.limit;

    const rows = await this.dataSource.query<PendingNodeOperatorRow[]>(
      `SELECT${NODE_OPERATOR_PROFILE_COLUMNS},
              u.email AS "userEmail", u."firstName" AS "userFirstName",
              u."lastName" AS "userLastName"
         FROM node_operator_profiles p
         JOIN nodes n ON n.id = p."nodeId"
         JOIN users u ON u.id = p."userId"
        WHERE u.status = 'pending_review'
        ORDER BY p."createdAt" ASC
        LIMIT $1 OFFSET $2`,
      [query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total
         FROM node_operator_profiles p
         JOIN users u ON u.id = p."userId"
        WHERE u.status = 'pending_review'`,
    );

    const items = rows.map((row) =>
      PendingNodeOperatorResponseDto.fromRow(row),
    );
    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
