import {
  CapacityAuditResult,
  NodeCapacityMismatchRow,
  RiderCapacityMismatchRow,
} from '../../application/capacity-audit-query.service';

export class RiderCapacityMismatchDto {
  riderId!: string;
  riderEmail!: string;
  storedCount!: number;
  expectedCount!: number;

  static fromRow(row: RiderCapacityMismatchRow): RiderCapacityMismatchDto {
    const dto = new RiderCapacityMismatchDto();
    dto.riderId = row.riderId;
    dto.riderEmail = row.riderEmail;
    dto.storedCount = row.storedCount;
    dto.expectedCount = row.expectedCount;
    return dto;
  }
}

export class NodeCapacityMismatchDto {
  nodeId!: string;
  nodeName!: string;
  storedCount!: number;
  expectedCount!: number;

  static fromRow(row: NodeCapacityMismatchRow): NodeCapacityMismatchDto {
    const dto = new NodeCapacityMismatchDto();
    dto.nodeId = row.nodeId;
    dto.nodeName = row.nodeName;
    dto.storedCount = row.storedCount;
    dto.expectedCount = row.expectedCount;
    return dto;
  }
}

export class CapacityAuditResponseDto {
  riders!: RiderCapacityMismatchDto[];
  nodes!: NodeCapacityMismatchDto[];

  static fromResult(result: CapacityAuditResult): CapacityAuditResponseDto {
    const dto = new CapacityAuditResponseDto();
    dto.riders = result.riders.map((row) =>
      RiderCapacityMismatchDto.fromRow(row),
    );
    dto.nodes = result.nodes.map((row) => NodeCapacityMismatchDto.fromRow(row));
    return dto;
  }
}
