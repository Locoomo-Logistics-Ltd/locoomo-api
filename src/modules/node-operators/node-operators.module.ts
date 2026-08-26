import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { NodesModule } from '../nodes/nodes.module';
import { PaymentsModule } from '../payments/payments.module';
import { ApproveNodeOperatorService } from './application/approve-node-operator.service';
import { NodeOperatorQueryService } from './application/node-operator-query.service';
import { OnboardNodeService } from './application/onboard-node.service';
import { SetNodePayoutAccountService } from './application/set-node-payout-account.service';
import { NodeOperatorProfileEntity } from './infrastructure/entities/node-operator-profile.entity';
import { NodeOperatorsController } from './interface/node-operators.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([NodeOperatorProfileEntity]),
    // NodesModule: NodesService.createPendingPortalNode/activate.
    // IdentityModule: ActivateUserService, for the approval flow.
    NodesModule,
    IdentityModule,
    // PaystackBankService, for PATCH me/payout-account verification.
    PaymentsModule,
  ],
  controllers: [NodeOperatorsController],
  providers: [
    OnboardNodeService,
    ApproveNodeOperatorService,
    NodeOperatorQueryService,
    SetNodePayoutAccountService,
  ],
  // Exported so handoffs can resolve "which Node does this operator run"
  // (NodeOperatorQueryService.getNodeIdForUser) — never by reaching into
  // node-operators' domain/infrastructure directly.
  exports: [NodeOperatorQueryService],
})
export class NodeOperatorsModule {}
