import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { MAX_ACTIVE_ORDERS_PER_RIDER } from '../domain/rider-capacity.constants';
import { RiderNotActiveException } from '../domain/exceptions/rider-not-active.exception';
import { RiderStatus } from '../domain/rider-status.enum';

interface RiderCapacityRow {
  status: RiderStatus;
  currentActiveOrderCount: number;
}

// Direct mirror of NodesService.reserveCapacitySlot/releaseCapacitySlot —
// same "SELECT ... FOR UPDATE, check, conditional UPDATE" shape, applied to
// a Rider's concurrent-delivery cap instead of a Node's parcel capacity.
// `riderId` throughout is the User id (RiderProfile.userId), matching how
// Order.riderId/consumerId are also User ids, never a sub-profile id.
@Injectable()
export class RiderCapacityService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  // manager is required, not optional — the FOR UPDATE lock only holds for
  // the caller's own transaction, same reasoning as reserveCapacitySlot.
  async reserveDeliverySlot(
    riderId: string,
    manager: EntityManager,
  ): Promise<boolean> {
    const rows = await manager.query<RiderCapacityRow[]>(
      `SELECT status, "currentActiveOrderCount" FROM rider_profiles WHERE "userId" = $1 FOR UPDATE`,
      [riderId],
    );
    const profile = rows[0];
    if (!profile) {
      throw new EntityNotFoundException('RiderProfile', riderId);
    }
    if (profile.status !== RiderStatus.ACTIVE) {
      throw new RiderNotActiveException();
    }
    if (profile.currentActiveOrderCount >= MAX_ACTIVE_ORDERS_PER_RIDER) {
      return false;
    }

    await manager.query(
      `UPDATE rider_profiles SET "currentActiveOrderCount" = "currentActiveOrderCount" + 1 WHERE "userId" = $1`,
      [riderId],
    );
    return true;
  }

  // Called once a rider's physical custody of a parcel ends — the
  // rider->destination-Node handoff (ARRIVED_AT_DESTINATION), not
  // COMPLETED, since that's the moment the rider is actually free to take
  // on another delivery. manager optional, same reasoning as
  // releaseCapacitySlot (a single UPDATE is already race-safe without a
  // lock).
  async releaseDeliverySlot(
    riderId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const runner = manager ?? this.dataSource.manager;
    await runner.query(
      `UPDATE rider_profiles SET "currentActiveOrderCount" = GREATEST("currentActiveOrderCount" - 1, 0) WHERE "userId" = $1`,
      [riderId],
    );
  }
}
