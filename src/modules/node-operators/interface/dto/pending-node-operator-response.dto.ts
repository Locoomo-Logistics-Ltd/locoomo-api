import { NodeResponseDto } from '../../../nodes/interface/dto/node-response.dto';
import { PendingNodeOperatorRow } from '../../application/node-operator-query.service';

type NodeEntityLike = Parameters<typeof NodeResponseDto.fromEntity>[0];

export class PendingNodeOperatorResponseDto {
  profileId!: string;
  userEmail!: string;
  userFirstName!: string;
  userLastName!: string;
  submittedAt!: Date;
  node!: NodeResponseDto;

  static fromRow(row: PendingNodeOperatorRow): PendingNodeOperatorResponseDto {
    const dto = new PendingNodeOperatorResponseDto();
    dto.profileId = row.profileId;
    dto.userEmail = row.userEmail;
    dto.userFirstName = row.userFirstName;
    dto.userLastName = row.userLastName;
    dto.submittedAt = row.submittedAt;
    dto.node = NodeResponseDto.fromEntity(row as unknown as NodeEntityLike);
    return dto;
  }
}
