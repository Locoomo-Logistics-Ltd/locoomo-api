import { Module } from '@nestjs/common';
import { OrderTimelineService } from './application/order-timeline.service';
import { PublicTrackingService } from './application/public-tracking.service';
import { TrackingEmailService } from './application/tracking-email.service';
import { TrackingLinkService } from './application/tracking-link.service';
import { TrackingController } from './interface/tracking.controller';

// Public parcel tracking: signed links, the unauthenticated tracking
// endpoint, and the tracking block (code, QR, link) other modules put in
// their emails.
@Module({
  controllers: [TrackingController],
  providers: [
    TrackingLinkService,
    TrackingEmailService,
    PublicTrackingService,
    OrderTimelineService,
  ],
  exports: [TrackingLinkService, TrackingEmailService, OrderTimelineService],
})
export class TrackingModule {}
