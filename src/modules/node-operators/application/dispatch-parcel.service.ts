import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { CreatePaymentIntentService } from '../../payments/application/create-payment-intent.service';
import { NodeNotActiveException } from '../domain/exceptions/node-not-active.exception';
import { DispatchParcelDto } from '../interface/dto/dispatch-parcel.dto';
import { NodeOperatorQueryService } from './node-operator-query.service';

// Owner AND staff may dispatch — operational work at a Node they're a
// member of, same treatment as the handoff-scan routes, not a
// revenue-configuration route like payout-account/staff-invite.
// getForNode already 404s (hidden as not-found) if the caller has no
// membership at all for :nodeId, which is exactly the "not your Node"
// rejection this needs — no separate ownership check required.
@Injectable()
export class DispatchParcelService {
  constructor(
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
    private readonly createPaymentIntentService: CreatePaymentIntentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // Return type inferred from CreatePaymentIntentService.create() rather
  // than named explicitly — naming it here would require importing
  // PaymentIntentEntity from payments' infrastructure/, which the
  // module-boundary rule forbids.
  async dispatch(userId: string, nodeId: string, dto: DispatchParcelDto) {
    const membership = await this.nodeOperatorQueryService.getForNode(
      userId,
      nodeId,
    );
    // Same reasoning as InviteNodeStaffService — the caller already knows
    // this Node exists (it's their own), so a clear 403 beats a confusing
    // 404 once they can see its status via GET /me/nodes.
    if ((membership.node.status as string) !== 'active') {
      throw new NodeNotActiveException();
    }
    await this.assertDestinationUsable(nodeId, dto.destinationNodeId);

    return this.createPaymentIntentService.create(
      userId,
      { ...dto, originNodeId: nodeId },
      { restrictToPublicNodes: false },
    );
  }

  // A private Node serves only its owner: a dispatch may go to any public
  // Node, or to a private one with the same owner as the sending Node
  // (a shop sending between its own branches). Anyone else's private Node
  // is hidden as not found, as it is everywhere else.
  private async assertDestinationUsable(
    originNodeId: string,
    destinationNodeId: string,
  ): Promise<void> {
    const [row] = await this.dataSource.query<
      { isPubliclyVisible: boolean; sameOwner: boolean }[]
    >(
      `SELECT d."isPubliclyVisible",
              EXISTS (
                SELECT 1 FROM node_memberships od
                  JOIN node_memberships dd
                    ON dd."userId" = od."userId" AND dd."nodeId" = $2
                   AND dd."roleAtNode" = 'owner' AND dd.status = 'active'
                 WHERE od."nodeId" = $1
                   AND od."roleAtNode" = 'owner' AND od.status = 'active'
              ) AS "sameOwner"
         FROM nodes d WHERE d.id = $2`,
      [originNodeId, destinationNodeId],
    );
    if (row && !row.isPubliclyVisible && !row.sameOwner) {
      throw new EntityNotFoundException('Node', destinationNodeId);
    }
  }
}
