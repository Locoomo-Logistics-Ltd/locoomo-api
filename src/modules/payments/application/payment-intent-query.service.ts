import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { PaymentIntentEntity } from '../infrastructure/entities/payment-intent.entity';

@Injectable()
export class PaymentIntentQueryService {
  constructor(
    @InjectRepository(PaymentIntentEntity)
    private readonly paymentIntents: Repository<PaymentIntentEntity>,
  ) {}

  // Backs the frontend's post-redirect polling — the consumer lands back on
  // our own callback page not knowing yet whether the webhook has landed,
  // and polls this until status leaves PENDING. Ownership-scoped: a consumer
  // can only read their own intents.
  async getMine(consumerId: string, id: string): Promise<PaymentIntentEntity> {
    const intent = await this.paymentIntents.findOneBy({ id, consumerId });
    if (!intent) {
      throw new EntityNotFoundException('PaymentIntent', id);
    }
    return intent;
  }
}
