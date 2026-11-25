import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsLatLong,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Public } from '../../../common/auth/decorators/public.decorator';
import type { CursorPage } from '../../../common/pagination/cursor';
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
} from '../../../common/pagination/cursor';
import type { OpeningHours } from '../../../common/opening-hours/opening-hours';
import type {
  AvailableNode,
  NodeLocationCount,
  NodeSort,
} from '../application/nodes.service';
import { NodesService } from '../application/nodes.service';

const SORTS: NodeSort[] = ['distance', 'name', 'city', 'state'];

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class PublicNodesQueryDto {
  /** Search name, address and city (contains, case-insensitive). */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Exact state, case-insensitive (see GET /public/nodes/locations). */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(60)
  state?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(100)
  city?: string;

  /** `latitude,longitude`: limits to `radiusKm` and enables distance. */
  @IsOptional()
  @IsLatLong({
    message: 'near must be "latitude,longitude", e.g. 6.5244,3.3792',
  })
  near?: string;

  /** With `near`: radius in km (default 10, max 50). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  radiusKm: number = 10;

  /** `true`: only Nodes with shelf space now; `false`: only full ones; omit for all. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  acceptingParcels?: boolean;

  /** `distance` (needs `near`; the default with it), `name` (default), `city`, `state`. */
  @IsOptional()
  @IsIn(SORTS)
  sort?: NodeSort;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;
}

// What anyone may see about a Node: where it is, when it's open and
// whether it has space. No phone numbers, capacity or operator details.
export interface PublicNode {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  openingHours: OpeningHours | null;
  acceptingParcels: boolean;
  // Set when listed `near` a point.
  distanceKm: number | null;
}

const publicView = (node: AvailableNode): PublicNode => ({
  id: node.id,
  name: node.name,
  address: node.address,
  city: node.city,
  state: node.state,
  latitude: node.latitude,
  longitude: node.longitude,
  openingHours: node.openingHours,
  acceptingParcels: node.acceptingParcels,
  distanceKm: node.distanceKm,
});

// The public Node directory (API.md "Public Node directory"): for the
// website's "find a Node" page and anyone embedding the list. Active,
// publicly visible Nodes only. No session or key.
@ApiTags('Public')
@Public()
@Controller('public/nodes')
export class PublicNodesController {
  constructor(private readonly nodes: NodesService) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Header('Cache-Control', 'public, max-age=60')
  async list(
    @Query() query: PublicNodesQueryDto,
  ): Promise<CursorPage<PublicNode>> {
    if (query.sort === 'distance' && !query.near) {
      throw new BadRequestException({
        message: 'Validation failed',
        details: [
          {
            field: 'sort',
            constraint: 'nearRequired',
            message: 'sort=distance needs near=latitude,longitude',
          },
        ],
      });
    }
    const offset = decodeOffsetCursor(query.cursor);
    const near = query.near?.split(',').map((part) => Number(part.trim()));
    const rows = await this.nodes.searchAvailable({
      near: near
        ? { latitude: near[0], longitude: near[1], radiusKm: query.radiusKm }
        : undefined,
      q: query.q || undefined,
      state: query.state || undefined,
      city: query.city || undefined,
      capacity:
        query.acceptingParcels === undefined
          ? 'any'
          : query.acceptingParcels
            ? 'available'
            : 'full',
      sort: query.sort,
      order: query.order,
      offset,
      limit: query.limit,
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: page.map(publicView),
      nextCursor: hasMore ? encodeOffsetCursor(offset + page.length) : null,
      hasMore,
    };
  }

  /** States and cities with a listed Node, with counts, for filter menus. */
  @Get('locations')
  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Header('Cache-Control', 'public, max-age=300')
  locations(): Promise<NodeLocationCount[]> {
    return this.nodes.availableLocations();
  }

  @Get(':id')
  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @Header('Cache-Control', 'public, max-age=60')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<PublicNode> {
    return publicView(await this.nodes.getAvailable(id));
  }
}
