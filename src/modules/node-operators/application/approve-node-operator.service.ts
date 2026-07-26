import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { ActivateUserService } from '../../identity/application/activate-user.service';
import { NodesService } from '../../nodes/application/nodes.service';
import { NodeOperatorProfileEntity } from '../infrastructure/entities/node-operator-profile.entity';
import { NodeOperatorResponseDto } from '../interface/dto/node-operator-response.dto';

@Injectable()
export class ApproveNodeOperatorService {
  constructor(
    @InjectRepository(NodeOperatorProfileEntity)
    private readonly profiles: Repository<NodeOperatorProfileEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly activateUserService: ActivateUserService,
    private readonly nodesService: NodesService,
  ) {}

  async approve(profileId: string): Promise<NodeOperatorResponseDto> {
    const profile = await this.profiles.findOneBy({ id: profileId });
    if (!profile) {
      throw new EntityNotFoundException('NodeOperatorProfile', profileId);
    }

    const node = await this.dataSource.transaction(async (manager) => {
      await this.activateUserService.activate(profile.userId, manager);
      return this.nodesService.activate(profile.nodeId, manager);
    });

    return NodeOperatorResponseDto.fromEntity(profile.id, node);
  }
}
