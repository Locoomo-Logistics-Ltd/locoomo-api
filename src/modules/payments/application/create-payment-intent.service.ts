import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Env } from '../../../config/env.validation';
import { EntityNotFoundException } from '../../../common/exceptions';
import { UserLookupService } from '../../identity/application/user-lookup.service';
import { NodesService } from '../../nodes/application/nodes.service';
import { NodeCapacityUnavailableException } from '../domain/exceptions/node-capacity-unavailable.exception';
import { PAYMENT_INTENT_TTL_MS } from '../domain/payment-intent.constants';
import { PaymentIntentStatus } from '../domain/payment-intent-status.enum';
import { PaymentProviderName } from '../domain/payment-provider-name.enum';
import { PaymentIntentEntity } from '../infrastructure/entities/payment-intent.entity';
import { PaymentProviderRegistry } from '../infrastructure/payment-provider.registry';
import { CreatePaymentIntentDto } from '../interface/dto/create-payment-intent.dto';
import { PricingService } from './pricing.service';

@Injectable()
export class CreatePaymentIntentService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly nodesService: NodesService,
    private readonly pricingService: PricingService,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly userLookupService: UserLookupService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  async create(
    // Named payerId, not consumerId — this is also called by node-operators'
    // DispatchParcelService on behalf of a NodeOperator/NodeStaff, so it's no
    // longer always a Consumer. PaymentIntentEntity.consumerId (the DB
    // column) is left as-is: renaming it would ripple into the webhook
    // handler, query service, and order creation for no correctness gain.
    payerId: string,
    dto: CreatePaymentIntentDto,
    options: { restrictToPublicNodes?: boolean } = {},
  ): Promise<{ intent: PaymentIntentEntity; authorizationUrl: string }> {
    // Active-only lookups (isAdmin: false) — a consumer can only book
    // against Nodes that are actually open for business, same guard
    // findNearby already applies.
    const originNode = await this.nodesService.findOne(dto.originNodeId, false);
    const destinationNode = await this.nodesService.findOne(
      dto.destinationNodeId,
      false,
    );

    // Consumer-initiated bookings (the default) can never target a private
    // Node, either as origin or destination — hidden as not-found, same as
    // any other Node a caller shouldn't be able to probe the existence of
    // (decision: search filtering alone is UX, not enforcement). Operator
    // dispatch (node-operators' DispatchParcelService) explicitly opts out —
    // a private Node dispatching its own parcels, or receiving as a
    // destination, is exactly the point of being private.
    if (options.restrictToPublicNodes ?? true) {
      if (!originNode.isPubliclyVisible) {
        throw new EntityNotFoundException('Node', dto.originNodeId);
      }
      if (!destinationNode.isPubliclyVisible) {
        throw new EntityNotFoundException('Node', dto.destinationNodeId);
      }
    }

    const feeBreakdown = await this.pricingService.calculateFee(
      originNode,
      destinationNode,
    );

    const intent = await this.dataSource.transaction(async (manager) => {
      // Capacity is enforced here, atomically, at booking time (decision:
      // hide full Nodes from search, but the real enforcement is this
      // locking transaction — a Node can go from "looked available" to
      // "full" between the consumer's search and this request under real
      // concurrency, E1).
      const reserved = await this.nodesService.reserveCapacitySlot(
        dto.originNodeId,
        manager,
      );
      if (!reserved) {
        throw new NodeCapacityUnavailableException(dto.originNodeId);
      }

      const repo = manager.getRepository(PaymentIntentEntity);
      return repo.save(
        repo.create({
          consumerId: payerId,
          originNodeId: dto.originNodeId,
          destinationNodeId: dto.destinationNodeId,
          receiverFullName: dto.receiverFullName,
          receiverEmail: dto.receiverEmail,
          receiverPhone: dto.receiverPhone,
          parcelDescription: dto.parcelDescription,
          parcelSize: dto.parcelSize,
          feeBreakdown,
          amountKobo: feeBreakdown.totalKobo,
          status: PaymentIntentStatus.PENDING,
          provider: PaymentProviderName.PAYSTACK,
          expiresAt: new Date(Date.now() + PAYMENT_INTENT_TTL_MS),
        }),
      );
    });

    // Our own id doubles as Paystack's transaction reference (see
    // PaymentProviderPort) — a separate statement after the reservation
    // transaction commits, so a slow/failed write here never holds the
    // Node-capacity row lock.
    intent.providerReference = intent.id;
    await this.dataSource
      .getRepository(PaymentIntentEntity)
      .update(intent.id, { providerReference: intent.id });

    // Outside the transaction — a network call to Paystack shouldn't hold
    // the DB transaction (and the Node-capacity row lock) open. If this
    // throws, the reserved PENDING intent still exists and simply expires
    // via ExpirePaymentIntentsService, releasing the slot — no compensating
    // rollback needed here.
    const payerEmail = await this.userLookupService.getEmail(payerId);
    const provider = this.paymentProviderRegistry.get(intent.provider);
    const { authorizationUrl } = await provider.initialize({
      reference: intent.id,
      amountKobo: intent.amountKobo,
      email: payerEmail,
      callbackUrl: `${this.configService.get('FRONTEND_URL', { infer: true })}/orders/payment-callback`,
      metadata: {
        consumerId: payerId,
        originNodeId: dto.originNodeId,
        originNodeName: originNode.name,
        destinationNodeId: dto.destinationNodeId,
        destinationNodeName: destinationNode.name,
      },
    });

    return { intent, authorizationUrl };
  }
}
