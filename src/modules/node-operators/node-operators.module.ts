import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { NodesModule } from '../nodes/nodes.module';
import { PaymentsModule } from '../payments/payments.module';
import { ApproveNodeOperatorService } from './application/approve-node-operator.service';
import { DispatchParcelService } from './application/dispatch-parcel.service';
import { InviteNodeStaffService } from './application/invite-node-staff.service';
import { NodeOperatorQueryService } from './application/node-operator-query.service';
import { OnboardNodeService } from './application/onboard-node.service';
import { SetNodePayoutAccountService } from './application/set-node-payout-account.service';
import { SetNodeVisibilityService } from './application/set-node-visibility.service';
import { NodeMembershipEntity } from './infrastructure/entities/node-membership.entity';
import { NodeOperatorsController } from './interface/node-operators.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([NodeMembershipEntity]),
    // NodesModule: NodesService.createPendingPortalNode/activate/
    // setVisibility.
    // IdentityModule: ActivateUserService (approval flow), InviteUserService
    // (staff-invite flow).
    NodesModule,
    IdentityModule,
    // PaystackBankService (PATCH me/payout-account verification),
    // CreatePaymentIntentService (DispatchParcelService — an operator's own
    // dispatch reuses the exact same checkout flow a Consumer booking uses).
    PaymentsModule,
  ],
  controllers: [NodeOperatorsController],
  providers: [
    OnboardNodeService,
    ApproveNodeOperatorService,
    NodeOperatorQueryService,
    SetNodePayoutAccountService,
    InviteNodeStaffService,
    SetNodeVisibilityService,
    DispatchParcelService,
  ],
  // Exported so handoffs/earnings can resolve "which Nodes can this
  // operator act on" (NodeOperatorQueryService.getNodeIdsForUser) — never
  // by reaching into node-operators' domain/infrastructure directly.
  exports: [NodeOperatorQueryService],
})
export class NodeOperatorsModule {}
