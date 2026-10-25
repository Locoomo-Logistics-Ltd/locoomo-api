import { Injectable } from '@nestjs/common';
import { NodesService } from '../../nodes/application/nodes.service';
import { NodeOperatorResponseDto } from '../interface/dto/node-operator-response.dto';
import { SetNodeContactDto } from '../interface/dto/set-node-contact.dto';
import { NodeOperatorQueryService } from './node-operator-query.service';

// Owner-only — same business-configuration bucket as visibility and payout
// account. Unlike visibility, not gated to active Nodes: a pending Node's
// owner should be able to fill these in before Admin approval, and Nodes
// created before these fields existed need a way to add them.
@Injectable()
export class SetNodeContactService {
  constructor(
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
    private readonly nodesService: NodesService,
  ) {}

  async set(
    userId: string,
    nodeId: string,
    dto: SetNodeContactDto,
  ): Promise<NodeOperatorResponseDto> {
    await this.nodeOperatorQueryService.assertOwner(userId, nodeId);
    await this.nodesService.setContactDetails(nodeId, dto);
    return this.nodeOperatorQueryService.getForNode(userId, nodeId);
  }
}
