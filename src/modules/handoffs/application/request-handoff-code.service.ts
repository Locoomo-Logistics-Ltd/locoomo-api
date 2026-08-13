import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { EntityNotFoundException } from '../../../common/exceptions';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { generateHandoffCode } from '../domain/handoff-code';
import { HandoffCodeEntity } from '../infrastructure/entities/handoff-code.entity';

const HANDOFF_CODE_TTL_MINUTES = 5;

export interface HandoffCodeIssued {
  code: string;
  expiresAt: Date;
}

// The security boundary this whole endpoint exists for: a rider who was
// never assigned this order can never get a valid code to show a Node
// operator, because the system refuses to mint one for them — the check
// happens here, at request time, not left to the operator to somehow
// notice at the counter.
@Injectable()
export class RequestHandoffCodeService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async request(
    orderId: string,
    riderId: string,
    type: HandoffCodeType,
  ): Promise<HandoffCodeIssued> {
    const rows = await this.dataSource.query<{ riderId: string | null }[]>(
      `SELECT "riderId" FROM orders WHERE id = $1`,
      [orderId],
    );
    const order = rows[0];
    if (!order || order.riderId !== riderId) {
      throw new EntityNotFoundException('Order', orderId);
    }

    const rawCode = generateHandoffCode();
    const expiresAt = new Date(Date.now() + HANDOFF_CODE_TTL_MINUTES * 60_000);

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(HandoffCodeEntity);
      // Supersede any prior unused code for this (order, type) pair — only
      // the most recently requested code should ever be valid, same
      // pattern as RequestPasswordResetService.
      await repo.delete({ orderId, type, usedAt: IsNull() });
      await repo.save(
        repo.create({
          orderId,
          type,
          codeHash: hashToken(rawCode),
          requestedByUserId: riderId,
          expiresAt,
          usedAt: null,
          failedAttempts: 0,
        }),
      );
    });

    return { code: rawCode, expiresAt };
  }
}
