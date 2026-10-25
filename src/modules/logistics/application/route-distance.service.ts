import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

// Road distance between two Nodes, learned from courier quotes (Sendii's
// quote carries distance_m). Pricing prefers it over the straight-line
// estimate; Nodes don't move, so one quote per pair is enough, refreshed
// whenever a newer one comes in.
@Injectable()
export class RouteDistanceService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async roadDistanceKm(
    originNodeId: string,
    destinationNodeId: string,
  ): Promise<number | null> {
    const [row] = await this.dataSource.query<{ roadDistanceMeters: number }[]>(
      `SELECT "roadDistanceMeters" FROM node_route_distances
        WHERE "originNodeId" = $1 AND "destinationNodeId" = $2`,
      [originNodeId, destinationNodeId],
    );
    return row ? row.roadDistanceMeters / 1000 : null;
  }

  async record(
    originNodeId: string,
    destinationNodeId: string,
    roadDistanceMeters: number,
    source: string,
    manager?: EntityManager,
  ): Promise<void> {
    await (manager ?? this.dataSource.manager).query(
      `INSERT INTO node_route_distances
         ("originNodeId", "destinationNodeId", "roadDistanceMeters", source, "updatedAt")
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT ("originNodeId", "destinationNodeId")
       DO UPDATE SET "roadDistanceMeters" = EXCLUDED."roadDistanceMeters",
                     source = EXCLUDED.source, "updatedAt" = now()`,
      [originNodeId, destinationNodeId, Math.round(roadDistanceMeters), source],
    );
  }
}
