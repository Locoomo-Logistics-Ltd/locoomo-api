import {
  RiderEarningsOrder,
  RiderEarningsRow,
} from '../../application/rider-earnings-query.service';

// Payout-readiness view — rider identity (email/name) so Admin can actually
// pay them, and amountKobo (never naira — see decision #14, this codebase
// stores/computes money in kobo everywhere except the one typed-input
// exception on POST /admin/pricing, which doesn't apply to a read-only
// report). Deliberately no receiver PII — payout has nothing to do with who
// received the parcel.
export class RiderEarningsOrderDto {
  id!: string;
  trackingCode!: string;
  amountKobo!: number;
  completedAt!: Date;

  static fromRow(row: RiderEarningsOrder): RiderEarningsOrderDto {
    const dto = new RiderEarningsOrderDto();
    dto.id = row.id;
    dto.trackingCode = row.trackingCode;
    dto.amountKobo = row.amountKobo;
    dto.completedAt = row.completedAt;
    return dto;
  }
}

export class RiderEarningsResponseDto {
  riderId!: string;
  riderEmail!: string;
  riderFirstName!: string;
  riderLastName!: string;
  completedOrderCount!: number;
  totalAmountKobo!: number;
  orders!: RiderEarningsOrderDto[];

  static fromRow(row: RiderEarningsRow): RiderEarningsResponseDto {
    const dto = new RiderEarningsResponseDto();
    dto.riderId = row.riderId;
    dto.riderEmail = row.riderEmail;
    dto.riderFirstName = row.riderFirstName;
    dto.riderLastName = row.riderLastName;
    dto.completedOrderCount = row.completedOrderCount;
    dto.totalAmountKobo = row.totalAmountKobo;
    dto.orders = row.orders.map((order) =>
      RiderEarningsOrderDto.fromRow(order),
    );
    return dto;
  }
}
