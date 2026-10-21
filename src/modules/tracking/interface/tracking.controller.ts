import { Controller, Get, Param, Query } from '@nestjs/common';
import { seconds, Throttle } from '@nestjs/throttler';
import { Public } from '../../../common/auth/decorators/public.decorator';
import { PublicTrackingService } from '../application/public-tracking.service';
import { PublicTrackingResponseDto } from './dto/public-tracking-response.dto';
import { TrackQueryDto } from './dto/track-query.dto';

// The receiver has no account, so this is public — protected instead by
// requiring the link token or phone digits on top of the tracking code, a
// uniform 404 for every failure, and a tight per-IP rate limit against
// guessing.
@Public()
@Controller('track')
export class TrackingController {
  constructor(private readonly publicTrackingService: PublicTrackingService) {}

  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Get(':trackingCode')
  track(
    @Param('trackingCode') trackingCode: string,
    @Query() query: TrackQueryDto,
  ): Promise<PublicTrackingResponseDto> {
    return this.publicTrackingService.track(trackingCode, query);
  }
}
