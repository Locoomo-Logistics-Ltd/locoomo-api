import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { InvalidHandoffCodeException } from '../domain/exceptions/invalid-handoff-code.exception';
import { HandoffCodeEntity } from '../infrastructure/entities/handoff-code.entity';

const MAX_HANDOFF_CODE_ATTEMPTS = 5;

// Shared by every step that checks a handoff code against what a caller
// typed in (pickup, arrival, collection) — one place owns expiry + the
// durable failedAttempts lockout instead of three near-identical copies.
// On success, marks the code used inside the caller's transaction (same
// atomicity as ConfirmPasswordResetService's usedAt pattern). On failure,
// throws — the caller's transaction (including any idempotency-key insert)
// rolls back so a wrong-code attempt can be retried, but the lockout
// counter itself is written through a separate connection first so it
// survives that rollback.
@Injectable()
export class HandoffCodeValidatorService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async validate(
    manager: EntityManager,
    orderId: string,
    type: HandoffCodeType,
    code: string,
  ): Promise<void> {
    const handoffCode = await manager.getRepository(HandoffCodeEntity).findOne({
      where: { orderId, type, usedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });

    const isValid =
      !!handoffCode &&
      handoffCode.expiresAt > new Date() &&
      handoffCode.failedAttempts < MAX_HANDOFF_CODE_ATTEMPTS &&
      hashToken(code) === handoffCode.codeHash;

    if (!isValid) {
      if (handoffCode) {
        await this.dataSource.query(
          `UPDATE handoff_codes SET "failedAttempts" = "failedAttempts" + 1 WHERE id = $1`,
          [handoffCode.id],
        );
      }
      throw new InvalidHandoffCodeException();
    }

    await manager
      .getRepository(HandoffCodeEntity)
      .update(handoffCode.id, { usedAt: new Date() });
  }
}
