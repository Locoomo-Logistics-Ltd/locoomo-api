import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AuditActor, AuditService } from '../../../common/audit/audit.service';
import {
  CloudinaryService,
  UploadSignature,
} from '../../../common/cloudinary/cloudinary.service';
import { EntityNotFoundException } from '../../../common/exceptions';
import {
  CursorPage,
  CursorPosition,
  cursorTime,
  decodeCursor,
  toCursorPage,
} from '../../../common/pagination/cursor';
import type { ApiKeyMode } from '../domain/api-key';
import {
  CLAIM_WINDOW_DAYS,
  claimAllowed,
  claimWindowOpen,
  ClaimSource,
  ClaimStatus,
  ClaimType,
  maxPayoutKobo,
} from '../domain/claim';
import {
  ClaimAlreadyDecidedException,
  ClaimAlreadyOpenException,
  ClaimNotAllowedException,
  ClaimPayoutTooHighException,
  ClaimWindowClosedException,
  TestModeOnlyException,
  UploadNotFoundException,
} from '../domain/exceptions/merchant.exceptions';
import { defaultTierFor, resolveLimits } from '../domain/merchant-limits';
import type { ExceptionType } from '../domain/shipment';
import { MerchantClaimEntity } from '../infrastructure/entities/merchant-claim.entity';
import { MerchantShipmentEntity } from '../infrastructure/entities/merchant-shipment.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import { MerchantNotifierService } from './merchant-notifier.service';
import type { MerchantCaller } from './merchant-state';
import { WalletService } from './wallet.service';
import { WebhookEmitterService } from './webhook-emitter.service';

// Public contract (MERCHANT_API.md §15).
export interface ClaimView {
  id: string;
  shipmentId: string;
  reference: string;
  trackingCode: string;
  type: ClaimType;
  source: ClaimSource;
  status: ClaimStatus;
  description: string;
  evidence: string[];
  declaredValueKobo: number | null;
  maxPayoutKobo: number;
  payoutKobo: number | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileClaimInput {
  shipmentId: string;
  type: ClaimType;
  description: string;
  evidence?: string[];
}

export interface ClaimFilter {
  status?: ClaimStatus;
  shipmentId?: string;
  limit: number;
  cursor?: string;
}

type ClaimRow = MerchantClaimEntity & {
  reference: string;
  trackingCode: string;
};

const ms = cursorTime('c."createdAt"');

export function claimView(row: ClaimRow): ClaimView {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    reference: row.reference,
    trackingCode: row.trackingCode,
    type: row.type,
    source: row.source,
    status: row.status,
    description: row.description,
    evidence: row.evidence,
    declaredValueKobo: row.declaredValueKobo,
    maxPayoutKobo: row.maxPayoutKobo,
    payoutKobo: row.payoutKobo,
    decisionNote: row.merchantNote,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Claims for lost or damaged parcels (plan §6.6, D18). Merchants file them
// within 30 days; Locoomo opens one itself when it records a parcel lost or
// damaged. An admin investigates; a payout runs only after a second
// `finance` admin approves it (AdminClaimsService), and is credited to the
// wallet. In test mode the merchant decides their own claims to try it out.
@Injectable()
export class MerchantClaimsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cloudinary: CloudinaryService,
    private readonly wallet: WalletService,
    private readonly webhooks: WebhookEmitterService,
    private readonly notifier: MerchantNotifierService,
    private readonly audit: AuditService,
  ) {}

  uploadSignature(caller: MerchantCaller): UploadSignature {
    return this.cloudinary.generateUploadSignature(
      this.folder(caller.merchantId),
    );
  }

  async file(
    caller: MerchantCaller,
    input: FileClaimInput,
    now = new Date(),
  ): Promise<ClaimView> {
    const evidence = [...new Set(input.evidence ?? [])];
    await Promise.all(
      evidence.map((publicId) =>
        this.assertOwnUpload(caller.merchantId, publicId),
      ),
    );
    const id = await this.dataSource.transaction(async (manager) => {
      const shipment = await this.lockShipment(
        manager,
        caller.merchantId,
        caller.mode,
        input.shipmentId,
      );
      if (!claimAllowed(input.type, shipment.status)) {
        throw new ClaimNotAllowedException(input.type, shipment.status);
      }
      if (!claimWindowOpen(shipment.statusChangedAt, now)) {
        throw new ClaimWindowClosedException(CLAIM_WINDOW_DAYS);
      }
      await this.assertNoActiveClaim(manager, shipment.id);
      const claim = await this.insert(manager, shipment, {
        type: input.type,
        source: 'merchant',
        description: input.description.trim(),
        evidence,
        filedByUserId: caller.userId,
        filedByApiKeyId: caller.keyId,
      });
      await this.audit.record(
        {
          actor: this.callerActor(caller),
          action: 'merchant.claim_filed',
          merchantId: caller.merchantId,
          target: { type: 'merchant_claim', id: claim.id },
          metadata: {
            shipmentId: shipment.id,
            type: input.type,
            mode: caller.mode,
          },
          context: caller.context,
        },
        manager,
      );
      return claim.id;
    });
    return this.get(caller, id);
  }

  // Called inside the transaction that moves a shipment to `exception`:
  // the shipment's open claim, or a new one Locoomo opens for the merchant.
  async openForException(
    manager: EntityManager,
    shipment: MerchantShipmentEntity,
    type: ExceptionType,
  ): Promise<string> {
    const active = await this.activeClaimId(manager, shipment.id);
    if (active) {
      return active;
    }
    const claim = await this.insert(manager, shipment, {
      type,
      source: 'exception',
      description:
        type === 'lost'
          ? 'Locoomo recorded this parcel as lost in its care.'
          : 'Locoomo recorded this parcel as damaged in its care.',
      evidence: [],
      filedByUserId: null,
      filedByApiKeyId: null,
    });
    return claim.id;
  }

  async list(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    filter: ClaimFilter,
  ): Promise<CursorPage<ClaimView>> {
    const params: unknown[] = [
      caller.merchantId,
      caller.mode,
      filter.limit + 1,
    ];
    const where = ['c."merchantId" = $1', 'c.mode = $2'];
    if (filter.status) {
      params.push(filter.status);
      where.push(`c.status = $${params.length}`);
    }
    if (filter.shipmentId) {
      params.push(filter.shipmentId);
      where.push(`c."shipmentId" = $${params.length}`);
    }
    const after = decodeCursor(filter.cursor);
    if (after) {
      params.push(after.t, after.id);
      where.push(
        `(${ms}, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    const rows = await this.rows(
      this.dataSource.manager,
      `${where.join(' AND ')} ORDER BY ${ms} DESC, c.id DESC LIMIT $3`,
      params,
    );
    return toCursorPage<ClaimRow, ClaimView>(
      rows,
      filter.limit,
      (row): CursorPosition => ({ t: row.createdAt.toISOString(), id: row.id }),
      claimView,
    );
  }

  async get(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    id: string,
  ): Promise<ClaimView> {
    const [row] = await this.rows(
      this.dataSource.manager,
      'c.id = $1 AND c."merchantId" = $2 AND c.mode = $3',
      [id, caller.merchantId, caller.mode],
    );
    if (!row) {
      throw new EntityNotFoundException('Claim', id);
    }
    return claimView(row);
  }

  // Sandbox: decide your own test claim, to see claim.decided and the
  // wallet credit without waiting for Locoomo.
  async decideTest(
    caller: MerchantCaller,
    id: string,
    input: {
      decision: 'approve' | 'reject';
      amountKobo?: number;
      note?: string;
    },
  ): Promise<ClaimView> {
    if (caller.mode !== 'test') {
      throw new TestModeOnlyException(
        'Only test claims can be decided by you. Locoomo decides live claims.',
      );
    }
    await this.dataSource.transaction(async (manager) => {
      const claim = await this.lockClaim(
        manager,
        id,
        caller.merchantId,
        'test',
      );
      const note = input.note?.trim() || null;
      if (input.decision === 'approve') {
        await this.approve(manager, claim, {
          amountKobo: input.amountKobo ?? claim.maxPayoutKobo,
          merchantNote: note,
          approvalId: null,
          decidedByUserId: caller.userId,
        });
      } else {
        await this.reject(manager, claim, {
          merchantNote: note,
          decidedByUserId: caller.userId,
        });
      }
    });
    return this.get(caller, id);
  }

  // ─── Shared with AdminClaimsService ────────────────────────────────────

  async lockClaim(
    manager: EntityManager,
    id: string,
    merchantId?: string,
    mode?: ApiKeyMode,
  ): Promise<MerchantClaimEntity> {
    const claim = await manager
      .getRepository(MerchantClaimEntity)
      .createQueryBuilder('c')
      .setLock('pessimistic_write')
      .where('c.id = :id', { id })
      .getOne();
    if (
      !claim ||
      (merchantId && claim.merchantId !== merchantId) ||
      (mode && claim.mode !== mode)
    ) {
      throw new EntityNotFoundException('Claim', id);
    }
    return claim;
  }

  // Pays the claim into the wallet and tells the merchant.
  async approve(
    manager: EntityManager,
    claim: MerchantClaimEntity,
    input: {
      amountKobo: number;
      merchantNote: string | null;
      approvalId: string | null;
      decidedByUserId: string | null;
    },
  ): Promise<void> {
    this.assertOpen(claim);
    if (input.amountKobo <= 0 || input.amountKobo > claim.maxPayoutKobo) {
      throw new ClaimPayoutTooHighException(claim.maxPayoutKobo);
    }
    const shipment = await manager.findOneByOrFail(MerchantShipmentEntity, {
      id: claim.shipmentId,
    });
    const entry = await this.wallet.creditClaim(manager, {
      merchantId: claim.merchantId,
      mode: claim.mode,
      claimId: claim.id,
      shipmentId: claim.shipmentId,
      amountKobo: input.amountKobo,
      description: `Claim payout: ${shipment.reference} (${shipment.trackingCode})`,
      approvalId: input.approvalId,
      createdByUserId: input.decidedByUserId,
    });
    claim.status = 'approved';
    claim.payoutKobo = input.amountKobo;
    claim.walletEntryId = entry.id;
    claim.merchantNote = input.merchantNote;
    claim.decidedByUserId = input.decidedByUserId;
    claim.decidedAt = new Date();
    await manager.save(claim);
    await this.decided(manager, claim, shipment);
  }

  async reject(
    manager: EntityManager,
    claim: MerchantClaimEntity,
    input: { merchantNote: string | null; decidedByUserId: string | null },
  ): Promise<void> {
    this.assertOpen(claim);
    const shipment = await manager.findOneByOrFail(MerchantShipmentEntity, {
      id: claim.shipmentId,
    });
    claim.status = 'rejected';
    claim.payoutApprovalId = null;
    claim.merchantNote = input.merchantNote;
    claim.decidedByUserId = input.decidedByUserId;
    claim.decidedAt = new Date();
    await manager.save(claim);
    await this.decided(manager, claim, shipment);
  }

  async rows(
    manager: EntityManager,
    whereAndTail: string,
    params: unknown[],
  ): Promise<ClaimRow[]> {
    const raw = await manager.query<
      (Omit<ClaimRow, 'declaredValueKobo' | 'maxPayoutKobo' | 'payoutKobo'> & {
        declaredValueKobo: string | null;
        maxPayoutKobo: string;
        payoutKobo: string | null;
      })[]
    >(
      `SELECT c.*, s.reference, s."trackingCode"
         FROM merchant_claims c
         JOIN merchant_shipments s ON s.id = c."shipmentId"
        WHERE ${whereAndTail}`,
      params,
    );
    return raw.map((row) => ({
      ...row,
      declaredValueKobo:
        row.declaredValueKobo === null ? null : Number(row.declaredValueKobo),
      maxPayoutKobo: Number(row.maxPayoutKobo),
      payoutKobo: row.payoutKobo === null ? null : Number(row.payoutKobo),
    }));
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async decided(
    manager: EntityManager,
    claim: MerchantClaimEntity,
    shipment: MerchantShipmentEntity,
  ): Promise<void> {
    const row: ClaimRow = Object.assign(claim, {
      reference: shipment.reference,
      trackingCode: shipment.trackingCode,
    });
    await this.webhooks.emit(manager, {
      merchantId: claim.merchantId,
      mode: claim.mode,
      type: 'claim.decided',
      data: { claim: claimView(row) },
    });
    const merchant = await manager.findOneByOrFail(MerchantEntity, {
      id: claim.merchantId,
    });
    await this.notifier.claimDecided(
      merchant,
      {
        status: claim.status as 'approved' | 'rejected',
        mode: claim.mode,
        trackingCode: shipment.trackingCode,
        reference: shipment.reference,
        payoutKobo: claim.payoutKobo,
        merchantNote: claim.merchantNote,
      },
      manager,
    );
  }

  private async insert(
    manager: EntityManager,
    shipment: MerchantShipmentEntity,
    input: {
      type: ClaimType;
      source: ClaimSource;
      description: string;
      evidence: string[];
      filedByUserId: string | null;
      filedByApiKeyId: string | null;
    },
  ): Promise<MerchantClaimEntity> {
    const merchant = await manager.findOneByOrFail(MerchantEntity, {
      id: shipment.merchantId,
    });
    const { claimCapKobo } = resolveLimits(
      merchant.tier ?? defaultTierFor(merchant.type),
      merchant.limitOverrides,
    );
    const declared = shipment.parcel.declaredValueKobo ?? null;
    return manager.save(
      manager.create(MerchantClaimEntity, {
        merchantId: shipment.merchantId,
        mode: shipment.mode,
        shipmentId: shipment.id,
        type: input.type,
        source: input.source,
        status: 'open',
        description: input.description.slice(0, 2000),
        evidence: input.evidence,
        declaredValueKobo: declared,
        maxPayoutKobo: maxPayoutKobo(declared, claimCapKobo),
        filedByUserId: input.filedByUserId,
        filedByApiKeyId: input.filedByApiKeyId,
      }),
    );
  }

  private async lockShipment(
    manager: EntityManager,
    merchantId: string,
    mode: ApiKeyMode,
    id: string,
  ): Promise<MerchantShipmentEntity> {
    const shipment = await manager
      .getRepository(MerchantShipmentEntity)
      .createQueryBuilder('s')
      .setLock('pessimistic_write')
      .where('s.id = :id AND s."merchantId" = :merchantId AND s.mode = :mode', {
        id,
        merchantId,
        mode,
      })
      .getOne();
    if (!shipment) {
      throw new EntityNotFoundException('Shipment', id);
    }
    return shipment;
  }

  private async activeClaimId(
    manager: EntityManager,
    shipmentId: string,
  ): Promise<string | null> {
    const [row] = await manager.query<{ id: string }[]>(
      `SELECT id FROM merchant_claims
        WHERE "shipmentId" = $1 AND status IN ('open', 'approved')`,
      [shipmentId],
    );
    return row?.id ?? null;
  }

  private async assertNoActiveClaim(
    manager: EntityManager,
    shipmentId: string,
  ): Promise<void> {
    const active = await this.activeClaimId(manager, shipmentId);
    if (active) {
      throw new ClaimAlreadyOpenException(active);
    }
  }

  private assertOpen(claim: MerchantClaimEntity): void {
    if (claim.status !== 'open') {
      throw new ClaimAlreadyDecidedException(claim.status);
    }
  }

  private folder(merchantId: string): string {
    return `merchants/${merchantId}/claims`;
  }

  private async assertOwnUpload(
    merchantId: string,
    publicId: string,
  ): Promise<void> {
    if (
      !publicId.startsWith(`${this.folder(merchantId)}/`) ||
      !(await this.cloudinary.resourceExists(publicId))
    ) {
      throw new UploadNotFoundException();
    }
  }

  private callerActor(caller: MerchantCaller): AuditActor {
    return caller.via === 'api_key'
      ? { type: 'api_key', id: caller.keyId, role: null }
      : { type: 'user', id: caller.userId };
  }
}
