import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Env } from '../../../config/env.validation';
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
    consumerId: string,
    dto: CreatePaymentIntentDto,
  ): Promise<{ intent: PaymentIntentEntity; authorizationUrl: string }> {
    // Active-only lookups (isAdmin: false) — a consumer can only book
    // against Nodes that are actually open for business, same guard
    // findNearby already applies.
    const originNode = await this.nodesService.findOne(dto.originNodeId, false);
    const destinationNode = await this.nodesService.findOne(
      dto.destinationNodeId,
      false,
    );

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
          consumerId,
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
    const consumerEmail = await this.userLookupService.getEmail(consumerId);
    const provider = this.paymentProviderRegistry.get(intent.provider);
    const { authorizationUrl } = await provider.initialize({
      reference: intent.id,
      amountKobo: intent.amountKobo,
      email: consumerEmail,
      callbackUrl: `${this.configService.get('FRONTEND_URL', { infer: true })}/orders/payment-callback`,
      metadata: {
        consumerId,
        originNodeId: dto.originNodeId,
        originNodeName: originNode.name,
        destinationNodeId: dto.destinationNodeId,
        destinationNodeName: destinationNode.name,
      },
    });

    return { intent, authorizationUrl };
  }
}
