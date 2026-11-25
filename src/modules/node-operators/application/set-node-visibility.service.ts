import { Injectable } from '@nestjs/common';
import { NodesService } from '../../nodes/application/nodes.service';
import { NodeNotActiveException } from '../domain/exceptions/node-not-active.exception';
import { PrivateNodeLimitReachedException } from '../domain/exceptions/private-node-limit-reached.exception';
import { PrivateNodeLimitService } from './private-node-limit.service';
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
    private readonly privateLimit: PrivateNodeLimitService,
  ) {}

  async set(
    userId: string,
    nodeId: string,
    dto: SetNodeVisibilityDto,
  ): Promise<NodeOperatorResponseDto> {
    const membership = await this.nodeOperatorQueryService.assertOwner(
      userId,
      nodeId,
    );
    if ((membership.node.status as string) !== 'active') {
      throw new NodeNotActiveException();
    }
    // Going private is for small, own-use Nodes: not one already past the
    // private limit this month (ops may have just made it public for that).
    if (!dto.isPubliclyVisible && membership.node.isPubliclyVisible) {
      const orders = await this.nodesService.monthlyOrderCount(nodeId);
      const limit = this.privateLimit.limit;
      if (orders >= limit) {
        throw new PrivateNodeLimitReachedException(orders, limit);
      }
    }

    await this.nodesService.setVisibility(nodeId, dto.isPubliclyVisible);
    return this.nodeOperatorQueryService.getForNode(userId, nodeId);
  }
}
