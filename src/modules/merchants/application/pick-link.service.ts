import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { createSecretBox } from '../../../common/crypto/data-encryption-key';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { SecretBox } from '../../../common/crypto/secret-box';
import { EntityNotFoundException } from '../../../common/exceptions';
import { toValidationDetails } from '../../../common/pipes/validation-exception-factory';
import type { CursorPage } from '../../../common/pagination/cursor';
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
} from '../../../common/pagination/cursor';
import type { Env } from '../../../config/env.validation';
import {
  DuplicateReferenceException,
  PickLinkFailedException,
  PickLinkUnavailableException,
} from '../domain/exceptions/merchant.exceptions';
import {
  firstName,
  newPickToken,
  PICK_LINK_DAYS,
  pickLinkStatus,
  PickLinkStatus,
} from '../domain/pick-link';
import { PickLinkEntity } from '../infrastructure/entities/pick-link.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import { CreateShipmentDto } from '../interface/dto/shipment.dto';
import type { QuoteQueryDto } from '../interface/dto/merchant-catalog.dto';
import { MerchantCatalogService } from './merchant-catalog.service';
import { MerchantShipmentService } from './merchant-shipment.service';
import type { MerchantCaller } from './merchant-state';

// Any valid uuid: lets a draft be validated like POST /shipments before
// the buyer has picked the real destination.
const PLACEHOLDER_NODE = '00000000-0000-4000-8000-000000000000';

export interface PickLinkView {
  id: string;
  reference: string;
  status: PickLinkStatus;
  // Share this with the buyer.
  url: string;
  receiverName: string;
  hidePrices: boolean;
  expiresAt: string;
  shipmentId: string | null;
  usedAt: string | null;
  createdAt: string;
}

// What the buyer's page shows: no more than they need.
export interface PublicPickLink {
  status: PickLinkStatus;
  merchantName: string;
  receiverFirstName: string;
  parcel: { description: string; size: string };
  hidePrices: boolean;
  expiresAt: string;
  // Once picked.
  picked: { trackingCode: string; nodeName: string } | null;
}

export interface PickNode {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  distanceKm: number | null;
  // null when the seller hides prices, or no origin is known yet.
  priceKobo: number | null;
}

type Draft = Record<string, unknown> & {
  receiver: { name: string };
  parcel: {
    description: string;
    size: string;
    weightKg?: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    handling?: string[];
  };
  origin?: { type: string; nodeId?: string };
};

// Pick links (plan §2.3, §12.3, M7b): a seller without a checkout shares a
// link (WhatsApp); the buyer picks their Node on a public page and the
// shipment is created then, exactly as if the seller had sent it (wallet
// hold, shipment.created, buyer notified). One use, 7 days.
@Injectable()
export class PickLinkService {
  private readonly box: SecretBox;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<Env, true>,
    private readonly shipments: MerchantShipmentService,
    private readonly catalog: MerchantCatalogService,
    private readonly audit: AuditService,
  ) {
    this.box = createSecretBox(config, 'pick-link');
  }

  // ─── Merchant ─────────────────────────────────────────────────────────

  async create(
    caller: MerchantCaller,
    input: { shipment: Record<string, unknown>; hidePrices?: boolean },
    now = new Date(),
  ): Promise<PickLinkView> {
    const draft = { ...input.shipment };
    delete draft.destinationNodeId;
    const dto = plainToInstance(CreateShipmentDto, {
      ...draft,
      destinationNodeId: PLACEHOLDER_NODE,
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      throw new BadRequestException({
        message: 'Validation failed',
        details: toValidationDetails(errors, 'shipment'),
      });
    }
    const [taken] = await this.dataSource.query<
      { kind: 'shipment' | 'pick_link'; id: string }[]
    >(
      `SELECT 'shipment' AS kind, id FROM merchant_shipments
        WHERE "merchantId" = $1 AND mode = $2 AND reference = $3
       UNION ALL
       SELECT 'pick_link', id FROM pick_links
        WHERE "merchantId" = $1 AND mode = $2 AND reference = $3
          AND status = 'open' AND "expiresAt" > now()
       LIMIT 1`,
      [caller.merchantId, caller.mode, dto.reference],
    );
    if (taken !== undefined) {
      throw taken.kind === 'shipment'
        ? new DuplicateReferenceException(taken.id)
        : new DuplicateReferenceException(null, taken.id);
    }
    // An expired open link with the same reference steps aside.
    await this.dataSource.query(
      `UPDATE pick_links SET status = 'cancelled'
        WHERE "merchantId" = $1 AND mode = $2 AND reference = $3
          AND status = 'open' AND "expiresAt" <= now()`,
      [caller.merchantId, caller.mode, dto.reference],
    );
    const token = newPickToken();
    let link: PickLinkEntity;
    try {
      link = await this.dataSource.manager.save(
        this.dataSource.manager.create(PickLinkEntity, {
          merchantId: caller.merchantId,
          mode: caller.mode,
          reference: dto.reference,
          tokenHash: hashToken(token),
          tokenSealed: this.box.seal(Buffer.from(token)),
          draft,
          hidePrices: input.hidePrices ?? false,
          status: 'open',
          expiresAt: new Date(now.getTime() + PICK_LINK_DAYS * 86_400_000),
          createdByUserId: caller.userId,
          createdByApiKeyId: caller.keyId,
        }),
      );
    } catch (error) {
      // Two creates racing on one reference: the open-reference index wins.
      if ((error as { code?: string }).code === '23505') {
        throw new DuplicateReferenceException(null);
      }
      throw error;
    }
    return this.view(link);
  }

  async list(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    filter: { limit: number; cursor?: string },
  ): Promise<CursorPage<PickLinkView>> {
    const offset = decodeOffsetCursor(filter.cursor);
    const rows = await this.dataSource.manager.find(PickLinkEntity, {
      where: { merchantId: caller.merchantId, mode: caller.mode },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: offset,
      take: filter.limit + 1,
    });
    const hasMore = rows.length > filter.limit;
    return {
      items: rows.slice(0, filter.limit).map((row) => this.view(row)),
      nextCursor: hasMore ? encodeOffsetCursor(offset + filter.limit) : null,
      hasMore,
    };
  }

  async get(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    id: string,
  ): Promise<PickLinkView> {
    return this.view(await this.own(caller, id));
  }

  async cancel(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    id: string,
  ): Promise<PickLinkView> {
    const link = await this.own(caller, id);
    const status = pickLinkStatus(link.status, link.expiresAt);
    if (status !== 'open') {
      throw new PickLinkUnavailableException(status);
    }
    link.status = 'cancelled';
    return this.view(await this.dataSource.manager.save(link));
  }

  // ─── Buyer (public) ───────────────────────────────────────────────────

  async publicView(token: string): Promise<PublicPickLink> {
    const link = await this.byToken(token);
    const [extra] = await this.dataSource.query<
      {
        merchantName: string;
        trackingCode: string | null;
        nodeName: string | null;
      }[]
    >(
      `SELECT m."tradingName" AS "merchantName", s."trackingCode",
              s.destination->>'nodeName' AS "nodeName"
         FROM merchants m
         LEFT JOIN merchant_shipments s ON s.id = $2
        WHERE m.id = $1`,
      [link.merchantId, link.shipmentId],
    );
    const draft = link.draft as Draft;
    return {
      status: pickLinkStatus(link.status, link.expiresAt),
      merchantName: extra.merchantName,
      receiverFirstName: firstName(draft.receiver.name),
      parcel: {
        description: draft.parcel.description,
        size: draft.parcel.size,
      },
      hidePrices: link.hidePrices,
      expiresAt: link.expiresAt.toISOString(),
      picked:
        extra.trackingCode && extra.nodeName
          ? { trackingCode: extra.trackingCode, nodeName: extra.nodeName }
          : null,
    };
  }

  // Nodes the buyer can pick, nearest first, priced from the seller's
  // origin (or hub) unless the seller hides prices.
  async nodes(
    token: string,
    query: { near?: string; q?: string; limit: number },
  ): Promise<PickNode[]> {
    const link = await this.openLink(token);
    const draft = link.draft as Draft;
    const page = await this.catalog.listNodes({
      near: query.near,
      q: query.q,
      radiusKm: 25,
      limit: query.limit,
    });
    const [merchant] = await this.dataSource.query<
      { hubNodeId: string | null }[]
    >(`SELECT "hubNodeId" FROM merchants WHERE id = $1`, [link.merchantId]);
    const origin =
      draft.origin?.type === 'node' ? draft.origin.nodeId : merchant?.hubNodeId;
    const nodes: PickNode[] = [];
    for (const node of page.items) {
      let priceKobo: number | null = null;
      if (!link.hidePrices && origin && origin !== node.id) {
        try {
          const quote = await this.catalog.quote(
            {
              originNodeId: origin,
              destinationNodeId: node.id,
              parcelSize: draft.parcel.size,
              weightKg: draft.parcel.weightKg,
              lengthCm: draft.parcel.lengthCm,
              widthCm: draft.parcel.widthCm,
              heightCm: draft.parcel.heightCm,
              handling: draft.parcel.handling,
            } as QuoteQueryDto,
            {
              hidePrices: false,
              merchant: { merchantId: link.merchantId, mode: link.mode },
            },
          );
          priceKobo = quote.amountKobo;
        } catch {
          // A Node we can't price is still listed; the seller's price
          // applies when the shipment is created.
        }
      }
      nodes.push({
        id: node.id,
        name: node.name,
        address: node.address,
        city: node.city,
        state: node.state,
        latitude: node.latitude,
        longitude: node.longitude,
        distanceKm: node.distanceKm,
        priceKobo,
      });
    }
    return nodes;
  }

  // The buyer's choice: claims the link, then creates the shipment as the
  // seller. If creation fails the link reopens.
  async pick(
    token: string,
    destinationNodeId: string,
    context: AuditRequestContext,
  ): Promise<{ trackingCode: string; nodeName: string | null }> {
    const link = await this.openLink(token);
    const claimed = await this.dataSource.query<[unknown[], number]>(
      `UPDATE pick_links SET status = 'used', "usedAt" = now(), "updatedAt" = now()
        WHERE id = $1 AND status = 'open' AND "expiresAt" > now()
        RETURNING id`,
      [link.id],
    );
    if (claimed[1] === 0) {
      throw new PickLinkUnavailableException('used');
    }
    const caller: MerchantCaller = {
      merchantId: link.merchantId,
      mode: link.mode,
      via: link.createdByApiKeyId ? 'api_key' : 'session',
      keyId: link.createdByApiKeyId,
      userId: link.createdByUserId,
      context,
    };
    let result: Awaited<ReturnType<MerchantShipmentService['createItem']>>;
    try {
      const merchant: MerchantEntity =
        await this.shipments.creatableMerchant(caller);
      result = await this.shipments.createItem(
        caller,
        merchant,
        { ...link.draft, destinationNodeId },
        'pick',
      );
    } catch (error) {
      await this.reopen(link.id);
      throw error;
    }
    if (!result.ok) {
      await this.reopen(link.id);
      throw new PickLinkFailedException(result.error);
    }
    await this.dataSource.query(
      `UPDATE pick_links SET "shipmentId" = $2 WHERE id = $1`,
      [link.id, result.shipment.id],
    );
    await this.audit.record({
      actor: { type: 'system', id: null },
      action: 'merchant.pick_link_used',
      merchantId: link.merchantId,
      target: { type: 'pick_link', id: link.id },
      metadata: { shipmentId: result.shipment.id },
      context,
    });
    return {
      trackingCode: result.shipment.trackingCode,
      nodeName: result.shipment.destination.nodeName,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async reopen(id: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE pick_links SET status = 'open', "usedAt" = NULL WHERE id = $1 AND status = 'used' AND "shipmentId" IS NULL`,
      [id],
    );
  }

  private async byToken(token: string): Promise<PickLinkEntity> {
    const link = await this.dataSource.manager.findOneBy(PickLinkEntity, {
      tokenHash: hashToken(token),
    });
    if (!link) {
      throw new EntityNotFoundException('Pick link', 'token');
    }
    return link;
  }

  private async openLink(token: string): Promise<PickLinkEntity> {
    const link = await this.byToken(token);
    const status = pickLinkStatus(link.status, link.expiresAt);
    if (status !== 'open') {
      throw new PickLinkUnavailableException(status);
    }
    return link;
  }

  private async own(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    id: string,
  ): Promise<PickLinkEntity> {
    const link = await this.dataSource.manager.findOneBy(PickLinkEntity, {
      id,
      merchantId: caller.merchantId,
      mode: caller.mode,
    });
    if (!link) {
      throw new EntityNotFoundException('Pick link', id);
    }
    return link;
  }

  private view(link: PickLinkEntity): PickLinkView {
    const token = this.box.open(link.tokenSealed).toString();
    const base = this.config
      .get('FRONTEND_URL', { infer: true })
      .replace(/\/+$/, '');
    return {
      id: link.id,
      reference: link.reference,
      status: pickLinkStatus(link.status, link.expiresAt),
      url: `${base}/pick/${token}`,
      receiverName: (link.draft as Draft).receiver.name,
      hidePrices: link.hidePrices,
      expiresAt: link.expiresAt.toISOString(),
      shipmentId: link.shipmentId,
      usedAt: link.usedAt?.toISOString() ?? null,
      createdAt: link.createdAt.toISOString(),
    };
  }
}
