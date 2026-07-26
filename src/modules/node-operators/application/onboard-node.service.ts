import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { isUniqueViolation } from '../../../common/database/is-unique-violation.util';
import { NodesService } from '../../nodes/application/nodes.service';
import { NodeOperatorAlreadyOnboardedException } from '../domain/exceptions/node-operator-already-onboarded.exception';
import { NodeOperatorProfileEntity } from '../infrastructure/entities/node-operator-profile.entity';
import { NodeOperatorResponseDto } from '../interface/dto/node-operator-response.dto';
import { OnboardNodeDto } from '../interface/dto/onboard-node.dto';

@Injectable()
export class OnboardNodeService {
  constructor(
    @InjectRepository(NodeOperatorProfileEntity)
    private readonly profiles: Repository<NodeOperatorProfileEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly nodesService: NodesService,
  ) {}

  async onboard(
    userId: string,
    dto: OnboardNodeDto,
  ): Promise<NodeOperatorResponseDto> {
    // One Node per operator, MVP — pre-check for the common case, DB unique
    // index on userId is the backstop against a concurrent double-submit.
    const existing = await this.profiles.findOneBy({ userId });
    if (existing) {
      throw new NodeOperatorAlreadyOnboardedException();
    }

    try {
      const { node, profile } = await this.dataSource.transaction(
        async (manager) => {
          const node = await this.nodesService.createPendingPortalNode(
            dto,
            manager,
          );
          const profile = await manager.save(
            manager.create(NodeOperatorProfileEntity, {
              userId,
              nodeId: node.id,
            }),
          );
          return { node, profile };
        },
      );

      return NodeOperatorResponseDto.fromEntity(profile.id, node);
    } catch (error) {
      // Pre-check above handles the common case; this catches the race
      // where two onboarding requests for the same operator land
      // concurrently.
      if (isUniqueViolation(error)) {
        throw new NodeOperatorAlreadyOnboardedException();
      }
      throw error;
    }
  }
}
