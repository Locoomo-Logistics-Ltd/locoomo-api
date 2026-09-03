import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { CannotRemoveOwnerMembershipException } from '../domain/exceptions/cannot-remove-owner-membership.exception';
import { NodeMembershipRole } from '../domain/node-membership-role.enum';
import { NodeMembershipStatus } from '../domain/node-membership-status.enum';
import { NodeMembershipEntity } from '../infrastructure/entities/node-membership.entity';
import { NodeOperatorQueryService } from './node-operator-query.service';

// Soft-removal, never a hard delete — flips status to REMOVED (see
// NodeMembershipEntity's comment). Doesn't touch the staff member's User
// account or any other membership they hold — only this one Node's access.
// Takes effect on their very next request: every Node-scoped read this
// codebase has already re-checks membership status against the DB per
// request, it doesn't just trust the JWT's role claim.
@Injectable()
export class RemoveNodeStaffService {
  constructor(
    @InjectRepository(NodeMembershipEntity)
    private readonly memberships: Repository<NodeMembershipEntity>,
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
  ) {}

  async remove(
    ownerUserId: string,
    nodeId: string,
    staffUserId: string,
  ): Promise<void> {
    await this.nodeOperatorQueryService.assertOwner(ownerUserId, nodeId);

    const target = await this.memberships.findOneBy({
      userId: staffUserId,
      nodeId,
      status: NodeMembershipStatus.ACTIVE,
    });
    if (!target) {
      throw new EntityNotFoundException('NodeMembership', staffUserId);
    }
    if (target.roleAtNode !== NodeMembershipRole.STAFF) {
      throw new CannotRemoveOwnerMembershipException();
    }

    await this.memberships.update(target.id, {
      status: NodeMembershipStatus.REMOVED,
    });
  }
}
