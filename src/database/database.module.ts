import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Env } from '../config/env.validation';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres' as const,
        url: config.get('DATABASE_URL', { infer: true }),
        autoLoadEntities: true,
        synchronize: false,
        logging: config.get('NODE_ENV', { infer: true }) === 'development',
      }),
    }),
  ],
})
export class DatabaseModule {}
