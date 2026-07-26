import { NodeResponseDto } from '../../../nodes/interface/dto/node-response.dto';
import { NodeOperatorProfileRow } from '../../application/node-operator-query.service';

// `node` typed via NodeResponseDto.fromEntity's own parameter type rather
// than importing NodeEntity directly — NodeEntity lives in nodes'
// infrastructure/ layer, which the module-boundary rule forbids importing
// cross-module. This keeps full type-safety without that import.
type NodeEntityLike = Parameters<typeof NodeResponseDto.fromEntity>[0];

export class NodeOperatorResponseDto {
  profileId!: string;
  node!: NodeResponseDto;

  static fromEntity(
    profileId: string,
    node: NodeEntityLike,
  ): NodeOperatorResponseDto {
    const dto = new NodeOperatorResponseDto();
    dto.profileId = profileId;
    dto.node = NodeResponseDto.fromEntity(node);
    return dto;
  }

  static fromRow(row: NodeOperatorProfileRow): NodeOperatorResponseDto {
    return NodeOperatorResponseDto.fromEntity(
      row.profileId,
      row as unknown as NodeEntityLike,
    );
  }
}
