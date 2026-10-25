import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination-query.dto';

export const NODE_QUEUES = [
  'to_receive',
  'to_dispatch',
  'incoming',
  'to_collect',
] as const;
export type NodeQueue = (typeof NODE_QUEUES)[number];

export class MyNodeOrdersQueryDto extends PaginationQueryDto {
  // Work queues for the counter. Omitted = every order that has touched the
  // caller's Nodes, as before.
  @IsOptional()
  @IsIn(NODE_QUEUES)
  queue?: NodeQueue;
}
