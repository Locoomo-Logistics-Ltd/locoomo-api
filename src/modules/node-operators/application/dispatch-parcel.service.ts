import { Injectable } from '@nestjs/common';
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

    return this.createPaymentIntentService.create(
      userId,
      { ...dto, originNodeId: nodeId },
      { restrictToPublicNodes: false },
    );
  }
}
