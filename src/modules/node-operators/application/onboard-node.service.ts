import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { isUniqueViolation } from '../../../common/database/is-unique-violation.util';
import { UserLookupService } from '../../identity/application/user-lookup.service';
import { NodesService } from '../../nodes/application/nodes.service';
import { NodeMembershipRole } from '../domain/node-membership-role.enum';
import { NodeMembershipStatus } from '../domain/node-membership-status.enum';
import { NodeOperatorAlreadyOnboardedException } from '../domain/exceptions/node-operator-already-onboarded.exception';
import { NodeOperatorNotOnboardedException } from '../domain/exceptions/node-operator-not-onboarded.exception';
import { ProfileIncompleteException } from '../domain/exceptions/profile-incomplete.exception';
import { NodeMembershipEntity } from '../infrastructure/entities/node-membership.entity';
import { NodeOperatorResponseDto } from '../interface/dto/node-operator-response.dto';
import { OnboardNodeDto } from '../interface/dto/onboard-node.dto';

@Injectable()
export class OnboardNodeService {
  constructor(
    @InjectRepository(NodeMembershipEntity)
    private readonly memberships: Repository<NodeMembershipEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly nodesService: NodesService,
    private readonly userLookupService: UserLookupService,
  ) {}

  // First Node — also what CLAUDE.md decision #12's two-step self-registration
  // flow means by "onboarding." Rejects if the caller already has an owner
  // membership anywhere; use addNode for a 2nd/3rd Node instead.
  async onboard(
    userId: string,
    dto: OnboardNodeDto,
  ): Promise<NodeOperatorResponseDto> {
    const alreadyOnboarded = await this.hasOwnerMembership(userId);
    if (alreadyOnboarded) {
      throw new NodeOperatorAlreadyOnboardedException();
    }
    return this.createNode(userId, dto);
  }

  // Additional Node for an operator who has already onboarded. Same
  // creation logic as onboard() (shared via createNode) — the only real
  // difference is the precondition is inverted.
  async addNode(
    userId: string,
    dto: OnboardNodeDto,
  ): Promise<NodeOperatorResponseDto> {
    const alreadyOnboarded = await this.hasOwnerMembership(userId);
    if (!alreadyOnboarded) {
      throw new NodeOperatorNotOnboardedException();
    }
    return this.createNode(userId, dto);
  }

  private async hasOwnerMembership(userId: string): Promise<boolean> {
    return this.memberships.exists({
      where: {
        userId,
        roleAtNode: NodeMembershipRole.OWNER,
        status: NodeMembershipStatus.ACTIVE,
      },
    });
  }

  private async createNode(
    userId: string,
    dto: OnboardNodeDto,
  ): Promise<NodeOperatorResponseDto> {
    // Phone is no longer collected at registration (password or Google) —
    // dispatch/physical handoffs need a real contact number, so this is the
    // hard-gate enforcement point.
    const phone = await this.userLookupService.getPhone(userId);
    if (!phone) {
      throw new ProfileIncompleteException();
    }

    try {
      const { node, membership } = await this.dataSource.transaction(
        async (manager: EntityManager) => {
          const node = await this.nodesService.createPendingPortalNode(
            dto,
            manager,
          );
          const membership = await manager.save(
            manager.create(NodeMembershipEntity, {
              userId,
              nodeId: node.id,
              roleAtNode: NodeMembershipRole.OWNER,
            }),
          );
          return { node, membership };
        },
      );

      return NodeOperatorResponseDto.fromEntity(
        membership.id,
        membership.roleAtNode,
        node,
      );
    } catch (error) {
      // Unlike the old unique(userId) index, unique(userId, nodeId) can't
      // catch a concurrent double-submit here — each call generates its own
      // fresh nodeId, so two racing requests just create two Nodes rather
      // than colliding. That's an acceptable, non-corrupting outcome now
      // that multiple Nodes per operator is a legitimate end state (worst
      // case: a double-clicked "onboard" button leaves an extra Node
      // awaiting Admin approval, sortable after the fact) — not worth a
      // locking primitive this codebase doesn't otherwise use. This catch
      // stays only as a generic backstop for a genuine (userId, nodeId)
      // collision, which in practice means nothing today.
      if (isUniqueViolation(error)) {
        throw new NodeOperatorAlreadyOnboardedException();
      }
      throw error;
    }
  }
}
