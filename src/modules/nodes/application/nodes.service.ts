import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { EntityNotFoundException } from '../../../common/exceptions';
import { NodeOnboardingType } from '../domain/node-onboarding-type.enum';
import { NodeStatus } from '../domain/node-status.enum';
import { NodeEntity } from '../infrastructure/entities/node.entity';
import { CreateNodeDto } from '../interface/dto/create-node.dto';
import { NearbyNodeResponseDto } from '../interface/dto/nearby-node-response.dto';
import { NearbyNodesQueryDto } from '../interface/dto/nearby-nodes-query.dto';
import { NodeQueryDto } from '../interface/dto/node-query.dto';
import { UpdateNodeDto } from '../interface/dto/update-node.dto';

export interface CreateNodeOptions {
  // Passed by node-operators' future self-registration flow so Node
  // creation participates in its own transaction (same pattern as
  // OutboxService.enqueueEmail's manager-passing).
  manager?: EntityManager;
  // Admin-initiated create (no manager) defaults to ACTIVE — Admin
  // authorship is itself the trust gate. The self-registration flow passes
  // PENDING explicitly; it's never client-settable through CreateNodeDto.
  status?: NodeStatus;
}

@Injectable()
export class NodesService {
  constructor(
    @InjectRepository(NodeEntity)
    private readonly nodes: Repository<NodeEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // A single INSERT (not a plain repo.save followed by a raw UPDATE) — since
  // `location` is NOT NULL and isn't TypeORM-mapped, a two-step write would
  // leave the row briefly location-less between statements. Setting it in
  // the same statement means the row is only ever valid.
  async create(
    dto: CreateNodeDto,
    options: CreateNodeOptions = {},
  ): Promise<NodeEntity> {
    const runner = options.manager ?? this.dataSource.manager;

    const [row] = await runner.query<NodeEntity[]>(
      `INSERT INTO nodes
         (name, address, city, state, country, latitude, longitude, capacity,
          status, "onboardingType", "operatingHours", location)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               ST_SetSRID(ST_MakePoint($7, $6), 4326)::geography)
       RETURNING id, name, address, city, state, country, latitude, longitude,
                 capacity, status, "onboardingType", "operatingHours",
                 "createdAt", "updatedAt"`,
      [
        dto.name,
        dto.address,
        dto.city,
        dto.state,
        dto.country ?? 'Nigeria',
        dto.latitude,
        dto.longitude,
        dto.capacity,
        options.status ?? NodeStatus.ACTIVE,
        dto.onboardingType ?? NodeOnboardingType.FIELD_RECRUITED,
        dto.operatingHours ?? null,
      ],
    );

    return row;
  }

  // Narrow entry point for node-operators' self-registration flow — takes a
  // plain field bag (no NodeOnboardingType/NodeStatus in its signature) so
  // the caller never needs those enums, which live in nodes' domain/ and
  // can't be imported cross-module. `manager` is required, not optional,
  // since this only makes sense as part of the caller's own transaction
  // (creating the linked NodeOperatorProfile alongside it).
  async createPendingPortalNode(
    dto: {
      name: string;
      address: string;
      city: string;
      state: string;
      country?: string;
      latitude: number;
      longitude: number;
      capacity: number;
      operatingHours?: string;
    },
    manager: EntityManager,
  ): Promise<NodeEntity> {
    return this.create(
      { ...dto, onboardingType: NodeOnboardingType.PORTAL },
      { manager, status: NodeStatus.PENDING },
    );
  }

  // Narrow entry point for node-operators' Admin-approval flow — same
  // enum-hiding reasoning as createPendingPortalNode.
  async activate(id: string, manager: EntityManager): Promise<NodeEntity> {
    return this.update(id, { status: NodeStatus.ACTIVE }, manager);
  }

  // manager: passed by node-operators' Admin-approval flow so Node.status
  // flips to ACTIVE in the same transaction as User.status — same
  // manager-passing convention as create().
  async update(
    id: string,
    dto: UpdateNodeDto,
    manager?: EntityManager,
  ): Promise<NodeEntity> {
    const repo = manager ? manager.getRepository(NodeEntity) : this.nodes;

    const node = await repo.findOneBy({ id });
    if (!node) {
      throw new EntityNotFoundException('Node', id);
    }

    node.name = dto.name ?? node.name;
    node.address = dto.address ?? node.address;
    node.city = dto.city ?? node.city;
    node.state = dto.state ?? node.state;
    node.country = dto.country ?? node.country;
    node.latitude = dto.latitude ?? node.latitude;
    node.longitude = dto.longitude ?? node.longitude;
    node.capacity = dto.capacity ?? node.capacity;
    node.operatingHours = dto.operatingHours ?? node.operatingHours;
    node.status = dto.status ?? node.status;

    const saved = await repo.save(node);

    if (dto.latitude !== undefined || dto.longitude !== undefined) {
      await this.syncLocation(
        manager ?? this.dataSource.manager,
        saved.id,
        saved.latitude,
        saved.longitude,
      );
    }

    return saved;
  }

  async findOne(id: string, isAdmin: boolean): Promise<NodeEntity> {
    const node = await this.nodes.findOneBy({ id });
    // Hides existence of non-active Nodes from non-Admins rather than
    // distinguishing 404-vs-403 — same rationale as not leaking whether an
    // email is registered elsewhere in identity.
    if (!node || (!isAdmin && node.status !== NodeStatus.ACTIVE)) {
      throw new EntityNotFoundException('Node', id);
    }
    return node;
  }

  async findAll(
    query: NodeQueryDto,
    isAdmin: boolean,
  ): Promise<PaginatedResultDto<NodeEntity>> {
    const status = isAdmin ? query.status : NodeStatus.ACTIVE;

    const [items, total] = await this.nodes.findAndCount({
      where: status ? { status } : {},
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      order: { createdAt: 'DESC' },
    });

    return new PaginatedResultDto(items, query.page, query.limit, total);
  }

  // Always active-only regardless of caller — this endpoint exists to
  // answer "where can I actually drop off a parcel right now."
  async findNearby(
    query: NearbyNodesQueryDto,
  ): Promise<PaginatedResultDto<NearbyNodeResponseDto>> {
    const radiusMeters = query.radiusKm * 1000;
    const offset = (query.page - 1) * query.limit;
    const origin = `ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography`;

    const rows = await this.dataSource.query<
      (NodeEntity & { distance: number })[]
    >(
      `SELECT id, name, address, city, state, country, latitude, longitude,
              capacity, status, "onboardingType", "operatingHours",
              "createdAt", "updatedAt",
              ST_Distance(location, ${origin}) AS distance
         FROM nodes
        WHERE status = $3
          AND ST_DWithin(location, ${origin}, $4)
        ORDER BY distance ASC
        LIMIT $5 OFFSET $6`,
      [
        query.longitude,
        query.latitude,
        NodeStatus.ACTIVE,
        radiusMeters,
        query.limit,
        offset,
      ],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total
         FROM nodes
        WHERE status = $3
          AND ST_DWithin(location, ${origin}, $4)`,
      [query.longitude, query.latitude, NodeStatus.ACTIVE, radiusMeters],
    );

    const items = rows.map((row) => NearbyNodeResponseDto.fromRow(row));

    return new PaginatedResultDto(items, query.page, query.limit, total);
  }

  private async syncLocation(
    runner: EntityManager,
    id: string,
    latitude: number,
    longitude: number,
  ): Promise<void> {
    await runner.query(
      `UPDATE nodes SET location = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography WHERE id = $3`,
      [longitude, latitude, id],
    );
  }
}
