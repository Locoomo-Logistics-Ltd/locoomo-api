import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination-query.dto';
import { NodeStatus } from '../../domain/node-status.enum';

// `status` is only honored for Admin callers — NodesService forces
// status=active for everyone else regardless of what's sent here, so
// unapproved Nodes never leak through this filter.
export class NodeQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(NodeStatus)
  status?: NodeStatus;
}
