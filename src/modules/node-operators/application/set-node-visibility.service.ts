import { Injectable } from '@nestjs/common';
import { EntityNotFoundException } from '../../../common/exceptions';
import { NodesService } from '../../nodes/application/nodes.service';
import { NodeNotActiveException } from '../domain/exceptions/node-not-active.exception';
import { NodeMembershipRole } from '../domain/node-membership-role.enum';
import { NodeOperatorResponseDto } from '../interface/dto/node-operator-response.dto';
import { SetNodeVisibilityDto } from '../interface/dto/set-node-visibility.dto';
import { NodeOperatorQueryService } from './node-operator-query.service';

// Owner-only — same bucket as SetNodePayoutAccountService/
// InviteNodeStaffService (business-configuration, not operational work
// staff should reach). Sourced through getForNode (not a plain
// membership-repo lookup like SetNodePayoutAccountService) because this
// needs the Node's own status for the active-only gate below.
@Injectable()
export class SetNodeVisibilityService {
  constructor(
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
    private readonly nodesService: NodesService,
  ) {}

  async set(
    userId: string,
    nodeId: string,
    dto: SetNodeVisibilityDto,
  ): Promise<NodeOperatorResponseDto> {
    const membership = await this.nodeOperatorQueryService.getForNode(
      userId,
      nodeId,
    );
    if (membership.roleAtNode !== (NodeMembershipRole.OWNER as string)) {
      throw new EntityNotFoundException('NodeMembership', nodeId);
    }
    if ((membership.node.status as string) !== 'active') {
      throw new NodeNotActiveException();
    }

    await this.nodesService.setVisibility(nodeId, dto.isPubliclyVisible);
    return this.nodeOperatorQueryService.getForNode(userId, nodeId);
  }
}
