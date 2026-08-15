import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { HandoffCodeIssued } from '../domain/handoff-code-issued';
import { HandoffCodeIssuerService } from './handoff-code-issuer.service';

const HANDOFF_CODE_TTL_MINUTES = 5;

// The security boundary this whole endpoint exists for: a rider who was
// never assigned this order can never get a valid code to show a Node
// operator, because the system refuses to mint one for them — the check
// happens here, at request time, not left to the operator to somehow
// notice at the counter.
@Injectable()
export class RequestHandoffCodeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly handoffCodeIssuerService: HandoffCodeIssuerService,
  ) {}

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

    return this.dataSource.transaction((manager) =>
      this.handoffCodeIssuerService.issue(
        manager,
        orderId,
        type,
        riderId,
        HANDOFF_CODE_TTL_MINUTES,
      ),
    );
  }
}
