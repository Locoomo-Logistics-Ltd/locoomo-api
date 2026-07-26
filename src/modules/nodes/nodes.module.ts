import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NodesService } from './application/nodes.service';
import { NodeEntity } from './infrastructure/entities/node.entity';
import { NodesController } from './interface/nodes.controller';

@Module({
  imports: [TypeOrmModule.forFeature([NodeEntity])],
  controllers: [NodesController],
  providers: [NodesService],
  // Exported so the future node-operators module can create a Node (within
  // its own transaction, via the manager option) as part of self-registration
  // — never by reaching into nodes' domain/infrastructure directly.
  exports: [NodesService],
})
export class NodesModule {}
