import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  StationNames,
  TimelineEntry,
  timelineEntryFor,
} from '../domain/public-status';

export type TimelineItem = TimelineEntry & { at: Date };

// An order's history in plain words (the same vocabulary as the public
// tracking page) — for the tracking page and for the sender's own order
// screen. Internal events with no public meaning are left out.
@Injectable()
export class OrderTimelineService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async timelineFor(
    orderId: string,
    names?: StationNames,
  ): Promise<TimelineItem[]> {
    const stations =
      names ??
      (
        await this.dataSource.query<StationNames[]>(
          `SELECT origin.name AS origin, dest.name AS destination
             FROM orders o
             JOIN nodes origin ON origin.id = o."originNodeId"
             JOIN nodes dest ON dest.id = o."destinationNodeId"
            WHERE o.id = $1`,
          [orderId],
        )
      )[0];
    if (!stations) {
      return [];
    }
    const events = await this.dataSource.query<
      { type: string; createdAt: Date }[]
    >(
      `SELECT type, "createdAt" FROM order_events
        WHERE "orderId" = $1 ORDER BY "createdAt" ASC, id ASC`,
      [orderId],
    );
    return events.flatMap((event) => {
      const entry = timelineEntryFor(event.type, stations);
      return entry ? [{ ...entry, at: event.createdAt }] : [];
    });
  }
}
