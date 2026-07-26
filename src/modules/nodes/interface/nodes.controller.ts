import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { UserRole } from '../../../common/auth/user-role.enum';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { NodesService } from '../application/nodes.service';
import { CreateNodeDto } from './dto/create-node.dto';
import { NearbyNodeResponseDto } from './dto/nearby-node-response.dto';
import { NearbyNodesQueryDto } from './dto/nearby-nodes-query.dto';
import { NodeQueryDto } from './dto/node-query.dto';
import { NodeResponseDto } from './dto/node-response.dto';
import { UpdateNodeDto } from './dto/update-node.dto';

// No class-level @Roles() — GET routes are open to any authenticated role
// (any user needs to discover active drop-off Nodes); only create/update
// are Admin-gated per-route.
@Controller('nodes')
export class NodesController {
  constructor(private readonly nodesService: NodesService) {}

  @Roles(UserRole.ADMIN)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateNodeDto): Promise<NodeResponseDto> {
    const node = await this.nodesService.create(dto);
    return NodeResponseDto.fromEntity(node);
  }

  @Get()
  async findAll(
    @Query() query: NodeQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResultDto<NodeResponseDto>> {
    const result = await this.nodesService.findAll(
      query,
      user.role === UserRole.ADMIN,
    );
    return new PaginatedResultDto(
      result.items.map((node) => NodeResponseDto.fromEntity(node)),
      result.page,
      result.limit,
      result.total,
    );
  }

  @Get('nearby')
  findNearby(
    @Query() query: NearbyNodesQueryDto,
  ): Promise<PaginatedResultDto<NearbyNodeResponseDto>> {
    return this.nodesService.findNearby(query);
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NodeResponseDto> {
    const node = await this.nodesService.findOne(
      id,
      user.role === UserRole.ADMIN,
    );
    return NodeResponseDto.fromEntity(node);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNodeDto,
  ): Promise<NodeResponseDto> {
    const node = await this.nodesService.update(id, dto);
    return NodeResponseDto.fromEntity(node);
  }
}
