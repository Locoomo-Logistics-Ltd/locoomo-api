import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { NodesService } from '../../nodes/application/nodes.service';
import {
  InvalidSimulationException,
  TestModeOnlyException,
} from '../domain/exceptions/merchant.exceptions';
import {
  addWorkingDays,
  COLLECTION_WORKING_DAYS,
  ExceptionType,
  generateCollectionCode,
  ShipmentStatus,
  simulationPath,
} from '../domain/shipment';
import { MerchantShipmentEntity } from '../infrastructure/entities/merchant-shipment.entity';
import type {
  ShipmentView,
  SimulateShipmentDto,
} from '../interface/dto/shipment.dto';
import { MerchantCaller } from './merchant-state';
import {
  MerchantShipmentService,
  nodeSnapshot,
} from './merchant-shipment.service';
import { ShipmentEventsService } from './shipment-events.service';
import { ShipmentPresenter } from './shipment-presenter';
import { WalletService } from './wallet.service';

const S = ShipmentStatus;
// How much a simulated re-measure raises the fee.
const SIMULATED_REMEASURE_FACTOR = 1.15;

// POST /test/shipments/{id}/simulate (MERCHANT_API.md §13): drives a test
// shipment the way live operations would, firing every intermediate step
// (and, from M2d, its webhook) in order.
@Injectable()
export class ShipmentSimulatorService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly shipments: MerchantShipmentService,
    private readonly events: ShipmentEventsService,
    private readonly nodes: NodesService,
    private readonly wallet: WalletService,
    private readonly presenter: ShipmentPresenter,
  ) {}

  async simulate(
    caller: MerchantCaller,
    id: string,
    dto: SimulateShipmentDto,
  ): Promise<ShipmentView> {
    if (caller.mode !== 'test') {
      throw new TestModeOnlyException();
    }
    // Picked before the transaction (Node lookups).
    const reroute =
      dto.to === 'destination_changed'
        ? await this.rerouteTarget(caller, id, dto.destinationNodeId)
        : null;

    const saved = await this.dataSource.transaction(async (manager) => {
      const shipment = await this.shipments.shipmentOf(
        manager,
        caller,
        id,
        true,
      );
      if (dto.to === 'fee_adjusted') {
        return this.adjustFee(manager, shipment);
      }
      if (dto.to === 'destination_changed') {
        const reroutable: ShipmentStatus[] = [
          S.CREATED,
          S.RECEIVED,
          S.IN_TRANSIT,
        ];
        if (!reroutable.includes(shipment.status)) {
          throw new InvalidSimulationException(shipment.status, dto.to);
        }
        const previous = shipment.destination;
        shipment.destination = reroute!;
        shipment.destinationChanged = true;
        return this.events.apply(manager, shipment, 'destination_changed', {
          nodeName: reroute!.nodeName,
          data: { previousDestination: previous },
        });
      }

      const target = dto.to;
      const path = simulationPath(shipment.status, target);
      if (!path) {
        throw new InvalidSimulationException(shipment.status, target);
      }
      let current = shipment;
      for (const step of path) {
        current = await this.step(manager, current, step, dto.exceptionType);
      }
      return current;
    });
    return this.presenter.view(saved);
  }

  private async step(
    manager: EntityManager,
    shipment: MerchantShipmentEntity,
    to: ShipmentStatus,
    exceptionType: ExceptionType = 'lost',
  ): Promise<MerchantShipmentEntity> {
    const from = shipment.status;
    const now = new Date();
    shipment.status = to;
    shipment.statusChangedAt = now;
    let nodeName: string | null = null;
    let data: Record<string, unknown> | null = null;
    let collectionCode: string | undefined;

    switch (to) {
      case S.RECEIVED:
        shipment.feeState = 'charged';
        shipment.chargedKobo = shipment.quotedKobo;
        nodeName = shipment.origin.nodeName;
        await this.wallet.captureHold(
          manager,
          shipment.id,
          shipment.quotedKobo,
          `Shipment ${shipment.trackingCode}`,
        );
        break;
      case S.IN_TRANSIT:
        nodeName = shipment.origin.nodeName;
        break;
      case S.READY_FOR_COLLECTION:
        shipment.collectionDeadline = addWorkingDays(
          now,
          COLLECTION_WORKING_DAYS,
        );
        nodeName = shipment.destination.nodeName;
        if (shipment.notifyReceiver !== 'locoomo') {
          collectionCode = generateCollectionCode();
        }
        break;
      case S.COLLECTED:
        shipment.collectedAt = now;
        shipment.collectionMethod = 'code';
        shipment.collectorName = shipment.receiverName;
        nodeName = shipment.destination.nodeName;
        break;
      case S.RETURNING: {
        const reason =
          from === S.READY_FOR_COLLECTION ? 'not_collected' : 'delivery_failed';
        shipment.returnInfo = { reason, readyForCollectionAt: null };
        data = { reason };
        break;
      }
      case S.RETURN_READY:
        shipment.returnInfo = {
          reason: shipment.returnInfo?.reason ?? 'not_collected',
          readyForCollectionAt: now.toISOString(),
        };
        nodeName = shipment.origin.nodeName;
        break;
      case S.RETURNED:
      case S.DISPOSED:
        nodeName = shipment.origin.nodeName;
        break;
      case S.CANCELLED:
      case S.EXPIRED:
        shipment.feeState = 'released';
        await this.wallet.releaseHold(manager, shipment.id);
        break;
      case S.REFUSED:
        shipment.feeState = 'released';
        await this.wallet.releaseHold(manager, shipment.id);
        nodeName = shipment.origin.nodeName;
        data = { reason: 'prohibited_item' };
        break;
      case S.EXCEPTION:
        shipment.exceptionInfo = {
          type: exceptionType,
          reportedAt: now.toISOString(),
          claimId: null,
        };
        data = { type: exceptionType };
        break;
      default:
        break;
    }
    return this.events.apply(manager, shipment, to, {
      nodeName,
      data,
      secrets: collectionCode ? { collectionCode } : undefined,
    });
  }

  private async adjustFee(
    manager: EntityManager,
    shipment: MerchantShipmentEntity,
  ): Promise<MerchantShipmentEntity> {
    if (shipment.feeState !== 'charged' || shipment.chargedKobo === null) {
      throw new InvalidSimulationException(shipment.status, 'fee_adjusted');
    }
    const previousKobo = shipment.chargedKobo;
    const newKobo = Math.round(previousKobo * SIMULATED_REMEASURE_FACTOR);
    shipment.chargedKobo = newKobo;
    shipment.measured = {
      weightKg: Math.round((shipment.parcel.weightKg ?? 1) * 1.5 * 100) / 100,
      size: shipment.parcel.size,
    };
    await this.wallet.adjustShipmentCharge(manager, {
      merchantId: shipment.merchantId,
      mode: shipment.mode,
      shipmentId: shipment.id,
      differenceKobo: newKobo - previousKobo,
      description: `Shipment ${shipment.trackingCode}: re-priced after measuring`,
    });
    return this.events.apply(manager, shipment, 'fee_adjusted', {
      nodeName: shipment.origin.nodeName,
      data: {
        adjustment: {
          previousKobo,
          newKobo,
          differenceKobo: newKobo - previousKobo,
          reason: 'measured_larger',
        },
      },
    });
  }

  // The new destination: the one asked for, or the nearest other open Node.
  private async rerouteTarget(
    caller: MerchantCaller,
    id: string,
    requested: string | undefined,
  ): Promise<ReturnType<typeof nodeSnapshot>> {
    const shipment = await this.shipments.shipmentOf(
      this.dataSource.manager,
      caller,
      id,
    );
    if (requested) {
      return nodeSnapshot(await this.shipments.availableDestination(requested));
    }
    const current = await this.nodes
      .getAvailable(shipment.destination.nodeId!)
      .catch(() => null);
    const candidates = current
      ? await this.nodes.searchAvailable({
          near: {
            latitude: current.latitude,
            longitude: current.longitude,
            radiusKm: 50,
          },
          offset: 0,
          limit: 5,
        })
      : [];
    const alternative = candidates.find(
      (node) => node.id !== shipment.destination.nodeId,
    );
    if (!alternative) {
      throw new InvalidSimulationException(
        shipment.status,
        'destination_changed (no other Node nearby; pass destinationNodeId)',
      );
    }
    return nodeSnapshot(alternative);
  }
}
