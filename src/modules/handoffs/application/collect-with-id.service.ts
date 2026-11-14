import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { OrdersService } from '../../orders/application/orders.service';
import {
  IdCheckFailedException,
  IdCheckLockedException,
} from '../domain/exceptions/counter.exceptions';
import { OrderNotReadyForCollectionException } from '../domain/exceptions/order-not-ready-for-collection.exception';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { CollectionCompletionService } from './collection-completion.service';
import { CounterUploadsService } from './counter-uploads.service';
import { OrderLookupService } from './order-lookup.service';

export const ID_CHECK_MAX_ATTEMPTS = 5;
export const ID_TYPES = [
  'nin',
  'passport',
  'drivers_licence',
  'voters_card',
] as const;

export interface IdCheckInput {
  collectorName: string;
  phoneLast4: string;
  idType: (typeof ID_TYPES)[number];
  idLast4: string;
  photoPublicId?: string;
}

// Counter fallback for a receiver without their code (plan §5.4, D19):
// staff check a photo ID and the last 4 digits of the receiver's phone.
// The phone digits are the system's check (5 tries per parcel, then only
// the code works); the name and ID are the operator's attestation, kept in
// the proof of delivery and the audit log.
@Injectable()
export class CollectWithIdService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderLookupService: OrderLookupService,
    private readonly ordersService: OrdersService,
    private readonly completion: CollectionCompletionService,
    private readonly uploads: CounterUploadsService,
    private readonly audit: AuditService,
  ) {}

  async collect(
    orderId: string,
    staffUserId: string,
    input: IdCheckInput,
    context: AuditRequestContext,
  ): Promise<OrderTransitionResult> {
    await this.orderLookupService.assertDestinationNodeOwnership(
      orderId,
      staffUserId,
    );
    if (input.photoPublicId) {
      await this.uploads.assertOwnUpload(staffUserId, input.photoPublicId);
    }

    // The failure is committed on its own so a wrong attempt always counts.
    const outcome = await this.dataSource.transaction(async (manager) => {
      const [order] = await manager.query<
        {
          status: string;
          receiverPhone: string;
          idCheckFailedAttempts: number;
        }[]
      >(
        `SELECT status, "receiverPhone", "idCheckFailedAttempts"
           FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      if (!order || order.status !== 'ready_for_collection') {
        throw new OrderNotReadyForCollectionException(orderId);
      }
      if (order.idCheckFailedAttempts >= ID_CHECK_MAX_ATTEMPTS) {
        throw new IdCheckLockedException();
      }
      const evidence = {
        collectorName: input.collectorName,
        idType: input.idType,
        idLast4: input.idLast4,
        staffUserId,
        photo: !!input.photoPublicId,
      };
      const expected = order.receiverPhone.replace(/\D/g, '').slice(-4);
      if (expected !== input.phoneLast4) {
        const attempts = await this.ordersService.recordIdCheckFailure(
          orderId,
          manager,
          evidence,
        );
        await this.audit.record(
          {
            actor: { type: 'user', id: staffUserId },
            action: 'order.id_check_failed',
            target: { type: 'order', id: orderId },
            metadata: { ...evidence, attempts },
            context,
          },
          manager,
        );
        return {
          ok: false as const,
          attemptsLeft: ID_CHECK_MAX_ATTEMPTS - attempts,
        };
      }
      const collected = await this.completion.complete(
        manager,
        orderId,
        { identityConfirmed: true, idCheck: evidence },
        {
          method: 'id_check',
          collectorName: input.collectorName,
          photoPublicId: input.photoPublicId ?? null,
        },
      );
      await this.audit.record(
        {
          actor: { type: 'user', id: staffUserId },
          action: 'order.collected_with_id',
          target: { type: 'order', id: orderId },
          metadata: evidence,
          context,
        },
        manager,
      );
      return { ok: true as const, order: collected };
    });

    if (!outcome.ok) {
      throw new IdCheckFailedException(Math.max(outcome.attemptsLeft, 0));
    }
    return outcome.order;
  }
}
