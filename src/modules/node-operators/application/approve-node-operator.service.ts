import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { ActivateUserService } from '../../identity/application/activate-user.service';
import { NodesService } from '../../nodes/application/nodes.service';
import { NodeMembershipEntity } from '../infrastructure/entities/node-membership.entity';
import { NodeOperatorResponseDto } from '../interface/dto/node-operator-response.dto';

@Injectable()
export class ApproveNodeOperatorService {
  constructor(
    @InjectRepository(NodeMembershipEntity)
    private readonly memberships: Repository<NodeMembershipEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly activateUserService: ActivateUserService,
    private readonly nodesService: NodesService,
  ) {}

  async approve(membershipId: string): Promise<NodeOperatorResponseDto> {
    const membership = await this.memberships.findOneBy({ id: membershipId });
    if (!membership) {
      throw new EntityNotFoundException('NodeMembership', membershipId);
    }

    const node = await this.dataSource.transaction(async (manager) => {
      // Idempotent-safe to re-run on an already-active account — an
      // operator's 2nd/3rd Node approval hits this again, harmlessly.
      await this.activateUserService.activate(membership.userId, manager);
      return this.nodesService.activate(membership.nodeId, manager);
    });

    return NodeOperatorResponseDto.fromEntity(
      membership.id,
      membership.roleAtNode,
      node,
    );
  }
}
