import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { timingSafeEqual } from 'crypto';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import type { OpeningHours } from '../../../common/opening-hours/opening-hours';
import { normalizeTrackingCode } from '../../orders/application/tracking-code-input';
import {
  FINAL_PUBLIC_STATUSES,
  nextStepFor,
  PUBLIC_STATUS_LABELS,
  timelineEntryFor,
  toPublicStatus,
} from '../domain/public-status';
import { PublicTrackingResponseDto } from '../interface/dto/public-tracking-response.dto';
import { TrackQueryDto } from '../interface/dto/track-query.dto';
import { TrackingLinkService } from './tracking-link.service';

// How long after collection the page keeps working.
const RETENTION_DAYS_AFTER_FINAL = 30;

interface TrackedOrderRow {
  id: string;
  trackingCode: string;
  status: string;
  receiverPhone: string;
  updatedAt: Date;
  originName: string;
  originCity: string;
  destinationName: string;
  destinationAddress: string;
  destinationCity: string;
  destinationState: string;
  destinationOpeningHours: OpeningHours | null;
}

// Raw SQL across orders/nodes/order_events (no imports of their entities —
// module boundary rule, same approach as handoffs' read queries).
@Injectable()
export class PublicTrackingService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly trackingLinkService: TrackingLinkService,
  ) {}

  async track(
    rawCode: string,
    query: TrackQueryDto,
  ): Promise<PublicTrackingResponseDto> {
    if ((query.t === undefined) === (query.phoneLast4 === undefined)) {
      throw new BadRequestException({
        message: 'Validation failed',
        details: [
          {
            field: 't',
            constraint: 'exactlyOne',
            message: 'send exactly one of t or phoneLast4',
          },
        ],
      });
    }

    // Unknown code, wrong token, wrong digits and an expired parcel all
    // produce this same 404 — the endpoint must not reveal which codes exist.
    const notFound = new EntityNotFoundException('Parcel', rawCode);

    const trackingCode = normalizeTrackingCode(rawCode);
    if (!trackingCode) {
      throw notFound;
    }
    const order = await this.findOrder(trackingCode);
    if (!order || !this.isAuthorised(order, query)) {
      throw notFound;
    }

    const status = toPublicStatus(order.status);
    if (!status || this.isExpired(status, order.updatedAt)) {
      throw notFound;
    }

    const names = {
      origin: order.originName,
      destination: order.destinationName,
    };
    const events = await this.dataSource.query<
      { type: string; createdAt: Date }[]
    >(
      `SELECT type, "createdAt" FROM order_events
        WHERE "orderId" = $1 ORDER BY "createdAt" ASC, id ASC`,
      [order.id],
    );

    const dto = new PublicTrackingResponseDto();
    dto.trackingCode = order.trackingCode;
    dto.status = status;
    dto.statusLabel = PUBLIC_STATUS_LABELS[status];
    dto.isFinal = FINAL_PUBLIC_STATUSES.has(status);
    dto.timeline = events.flatMap((event) => {
      const entry = timelineEntryFor(event.type, names);
      return entry ? [{ ...entry, at: event.createdAt }] : [];
    });
    dto.origin = { name: order.originName, city: order.originCity };
    dto.destination = {
      name: order.destinationName,
      address: order.destinationAddress,
      city: order.destinationCity,
      state: order.destinationState,
      openingHours: order.destinationOpeningHours,
    };
    dto.courierLabel = ['rider_assigned', 'in_transit'].includes(order.status)
      ? 'Locoomo rider'
      : null;
    dto.etaMinutes = null;
    dto.nextStep = nextStepFor(status, names);
    dto.updatedAt = order.updatedAt;
    return dto;
  }

  private async findOrder(
    trackingCode: string,
  ): Promise<TrackedOrderRow | undefined> {
    const rows = await this.dataSource.query<TrackedOrderRow[]>(
      `SELECT o.id, o."trackingCode", o.status, o."receiverPhone", o."updatedAt",
              origin.name AS "originName", origin.city AS "originCity",
              dest.name AS "destinationName", dest.address AS "destinationAddress",
              dest.city AS "destinationCity", dest.state AS "destinationState",
              dest."openingHours" AS "destinationOpeningHours"
         FROM orders o
         JOIN nodes origin ON origin.id = o."originNodeId"
         JOIN nodes dest ON dest.id = o."destinationNodeId"
        WHERE o."trackingCode" = $1`,
      [trackingCode],
    );
    return rows[0];
  }

  private isAuthorised(order: TrackedOrderRow, query: TrackQueryDto): boolean {
    if (query.t !== undefined) {
      return this.trackingLinkService.isValidToken(order.trackingCode, query.t);
    }
    const expected = Buffer.from(
      order.receiverPhone.replace(/\D/g, '').slice(-4),
    );
    const actual = Buffer.from(query.phoneLast4 ?? '');
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  private isExpired(
    status: ReturnType<typeof toPublicStatus>,
    updatedAt: Date,
  ): boolean {
    if (!status || !FINAL_PUBLIC_STATUSES.has(status)) {
      return false;
    }
    const cutoff = Date.now() - RETENTION_DAYS_AFTER_FINAL * 24 * 60 * 60_000;
    return updatedAt.getTime() < cutoff;
  }
}
