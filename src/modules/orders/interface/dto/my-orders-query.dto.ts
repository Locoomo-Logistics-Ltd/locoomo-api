import { Transform } from 'class-transformer';
import { ArrayUnique, IsArray, IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination-query.dto';
import { OrderStatus } from '../../domain/order-status.enum';

const STATUSES = Object.values(OrderStatus);

export class MyOrdersQueryDto extends PaginationQueryDto {
  // Comma-separated, e.g. ?status=return_initiated,return_in_transit,returned_to_origin,
  // ready_for_sender_collection,return_completed for a "Returns" tab.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayUnique()
  @IsIn(STATUSES, {
    each: true,
    message: `status values must be from: ${STATUSES.join(', ')}`,
  })
  status?: OrderStatus[];
}
