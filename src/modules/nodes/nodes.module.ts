import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Env } from '../../config/env.validation';
import { NodeLocationVerifierService } from './application/node-location-verifier.service';
import { NodesService } from './application/nodes.service';
import type { Geocoder } from './domain/ports/geocoder.port';
import { NodeEntity } from './infrastructure/entities/node.entity';
import { GEOCODER } from './infrastructure/geocoder.token';
import { GoogleGeocoder } from './infrastructure/google-geocoder';
import { NullGeocoder } from './infrastructure/null-geocoder';
import { NodesController } from './interface/nodes.controller';

@Module({
  imports: [TypeOrmModule.forFeature([NodeEntity])],
  controllers: [NodesController],
  providers: [
    NodesService,
    NodeLocationVerifierService,
    GoogleGeocoder,
    {
      provide: GEOCODER,
      // Picked once at boot. NODE_ENV=test always gets NullGeocoder so e2e
      // suites never call Google even when a developer's .env has a real
      // key — the suite that tests this flow overrides GEOCODER with a fake.
      useFactory: (
        configService: ConfigService<Env, true>,
        google: GoogleGeocoder,
      ): Geocoder =>
        configService.get('NODE_ENV', { infer: true }) !== 'test' &&
        configService.get('GOOGLE_MAPS_API_KEY', { infer: true })
          ? google
          : new NullGeocoder(),
      inject: [ConfigService, GoogleGeocoder],
    },
  ],
  // Exported so the future node-operators module can create a Node (within
  // its own transaction, via the manager option) as part of self-registration
  // — never by reaching into nodes' domain/infrastructure directly.
  exports: [NodesService],
})
export class NodesModule {}
