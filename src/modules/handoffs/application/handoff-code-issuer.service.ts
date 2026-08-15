import { Injectable } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { generateHandoffCode } from '../domain/handoff-code';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { HandoffCodeIssued } from '../domain/handoff-code-issued';
import { HandoffCodeEntity } from '../infrastructure/entities/handoff-code.entity';

// Shared by every step that mints a handoff code (rider pickup/arrival
// requests, destination-intake's collection code, and collection-code
// resend) — one place owns "generate, hash, supersede the prior unused
// code, save" instead of each call site repeating it. Takes the caller's
// manager so it can run inside a larger transaction (e.g. atomically with
// the status transition + outbox email at intake) or a standalone one (the
// rider request-code endpoints, which do nothing else).
@Injectable()
export class HandoffCodeIssuerService {
  async issue(
    manager: EntityManager,
    orderId: string,
    type: HandoffCodeType,
    requestedByUserId: string | null,
    ttlMinutes: number,
  ): Promise<HandoffCodeIssued> {
    const rawCode = generateHandoffCode();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

    const repo = manager.getRepository(HandoffCodeEntity);
    // Supersede any prior unused code for this (order, type) pair — only
    // the most recently issued code should ever be valid, same pattern as
    // RequestPasswordResetService.
    await repo.delete({ orderId, type, usedAt: IsNull() });
    await repo.save(
      repo.create({
        orderId,
        type,
        codeHash: hashToken(rawCode),
        requestedByUserId,
        expiresAt,
        usedAt: null,
        failedAttempts: 0,
      }),
    );

    return { code: rawCode, expiresAt };
  }
}
