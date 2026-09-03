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
  roleAtNode: string;
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
  isPubliclyVisible: boolean;
  createdAt: Date;
}

export interface PendingNodeOperatorRow extends NodeOperatorProfileRow {
  userEmail: string;
  userFirstName: string;
  userLastName: string;
}

const NODE_MEMBERSHIP_COLUMNS = `
  m.id AS "profileId",
  m."createdAt" AS "submittedAt",
  m."roleAtNode",
  m."payoutBankCode", m."payoutBankName", m."payoutAccountNumber",
  m."payoutAccountName", m."payoutAccountVerifiedAt",
  n.id, n.name, n.address, n.city, n.state, n.country, n.latitude, n.longitude,
  n.capacity, n.status, n."onboardingType", n."operatingHours",
  n."isPubliclyVisible", n."createdAt"`;

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

  // Every Node this user has a membership at — owner or (Phase 2) staff —
  // oldest first. Replaces getMine(): a user can now run more than one
  // Node, so this can no longer assume/return a single row.
  async listMine(userId: string): Promise<NodeOperatorResponseDto[]> {
    const rows = await this.dataSource.query<NodeOperatorProfileRow[]>(
      `SELECT${NODE_MEMBERSHIP_COLUMNS}
         FROM node_memberships m
         JOIN nodes n ON n.id = m."nodeId"
        WHERE m."userId" = $1
        ORDER BY m."createdAt" ASC`,
      [userId],
    );

    return rows.map((row) => NodeOperatorResponseDto.fromRow(row));
  }

  // The single membership for one specific Node — used wherever a caller
  // already knows which Node they mean (payout-account set/read) and needs
  // the full Node-joined view back, not the whole list.
  async getForNode(
    userId: string,
    nodeId: string,
  ): Promise<NodeOperatorResponseDto> {
    const rows = await this.dataSource.query<NodeOperatorProfileRow[]>(
      `SELECT${NODE_MEMBERSHIP_COLUMNS}
         FROM node_memberships m
         JOIN nodes n ON n.id = m."nodeId"
        WHERE m."userId" = $1 AND m."nodeId" = $2`,
      [userId, nodeId],
    );

    const row = rows[0];
    if (!row) {
      throw new EntityNotFoundException('NodeMembership', nodeId);
    }
    return NodeOperatorResponseDto.fromRow(row);
  }

  // Narrow export for handoffs/earnings — every Node-operator-facing
  // scan/confirm/earnings step needs "which Nodes can this authenticated
  // caller act on" to scope its own reads/writes. Owner and staff (Phase 2)
  // are both included — operating a Node's handoffs isn't owner-only.
  async getNodeIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.dataSource.query<{ nodeId: string }[]>(
      `SELECT "nodeId" FROM node_memberships WHERE "userId" = $1`,
      [userId],
    );
    return rows.map((row) => row.nodeId);
  }

  async listPending(
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<PendingNodeOperatorResponseDto>> {
    const offset = (query.page - 1) * query.limit;

    // Node-status-driven, not User-status-driven: an already-active
    // operator's 2nd/3rd Node still needs Admin review even though their
    // own account is already `active`, so filtering on the Node's own
    // `pending` status (rather than the user's) is what actually surfaces
    // it. roleAtNode = 'owner' since a pending Node is always reviewed via
    // whoever owns it, not any staff member.
    const rows = await this.dataSource.query<PendingNodeOperatorRow[]>(
      `SELECT${NODE_MEMBERSHIP_COLUMNS},
              u.email AS "userEmail", u."firstName" AS "userFirstName",
              u."lastName" AS "userLastName"
         FROM node_memberships m
         JOIN nodes n ON n.id = m."nodeId"
         JOIN users u ON u.id = m."userId"
        WHERE n.status = 'pending' AND m."roleAtNode" = 'owner'
        ORDER BY m."createdAt" ASC
        LIMIT $1 OFFSET $2`,
      [query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total
         FROM node_memberships m
         JOIN nodes n ON n.id = m."nodeId"
        WHERE n.status = 'pending' AND m."roleAtNode" = 'owner'`,
    );

    const items = rows.map((row) =>
      PendingNodeOperatorResponseDto.fromRow(row),
    );
    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
