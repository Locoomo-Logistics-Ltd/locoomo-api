import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination-query.dto';

// No radius cap unlike NearbyNodesQueryDto — the result set here is
// inherently small (however many parcels are currently sitting unclaimed
// at any origin Node across a 5-10 Node pilot), so filtering to a distance
// window isn't needed the way it is for consumer Node search.
export class AvailableOrdersQueryDto extends PaginationQueryDto {
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @Type(() => Number)
  @IsLongitude()
  longitude!: number;
}
