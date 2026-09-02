import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { InviteUserService } from '../../identity/application/invite-user.service';
import { UserResponseDto } from '../../identity/interface/dto/user-response.dto';
import { NodeMembershipRole } from '../domain/node-membership-role.enum';
import { NodeNotActiveException } from '../domain/exceptions/node-not-active.exception';
import { NodeMembershipEntity } from '../infrastructure/entities/node-membership.entity';
import { InviteNodeStaffDto } from '../interface/dto/invite-node-staff.dto';
import { NodeOperatorQueryService } from './node-operator-query.service';

// The first non-Admin-provisioning invite path in this codebase — an
// owner, not an Admin, is provisioning another User account. Reuses
// identity's existing invite/confirm mechanism end to end
// (InviteUserService.inviteNodeStaff + the unchanged POST
// /auth/invite/confirm) rather than building a parallel one.
@Injectable()
export class InviteNodeStaffService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
    private readonly inviteUserService: InviteUserService,
  ) {}

  async invite(
    ownerUserId: string,
    nodeId: string,
    dto: InviteNodeStaffDto,
  ): Promise<UserResponseDto> {
    // getForNode 404s if the caller has no membership at all for this
    // nodeId — hides whether the Node even exists, same as
    // SetNodePayoutAccountService. A membership that exists but isn't
    // OWNER (can't happen yet in practice — this route is
    // @Roles(NODE_OPERATOR)-only, and staff can't reach it — but checked
    // explicitly rather than assumed) gets the same hidden treatment.
    const membership = await this.nodeOperatorQueryService.getForNode(
      ownerUserId,
      nodeId,
    );
    if (membership.roleAtNode !== (NodeMembershipRole.OWNER as string)) {
      throw new EntityNotFoundException('NodeMembership', nodeId);
    }

    // Unlike the ownership check above, the caller already knows this Node
    // exists and can see its status via GET /me/nodes — a clear error
    // serves them better than hiding this as not-found. Compared as a
    // string, not the NodeStatus enum — that lives in nodes' domain/, which
    // the module-boundary rule forbids importing cross-module.
    if ((membership.node.status as string) !== 'active') {
      throw new NodeNotActiveException();
    }

    return this.dataSource.transaction(async (manager) => {
      const staffUser = await this.inviteUserService.inviteNodeStaff(
        dto,
        manager,
      );
      await manager.save(
        manager.create(NodeMembershipEntity, {
          userId: staffUser.id,
          nodeId,
          roleAtNode: NodeMembershipRole.STAFF,
        }),
      );
      return staffUser;
    });
  }
}
