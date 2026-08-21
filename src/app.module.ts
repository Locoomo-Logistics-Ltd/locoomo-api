import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AdminModule } from './modules/admin/admin.module';
import { EarningsModule } from './modules/earnings/earnings.module';
import { HandoffsModule } from './modules/handoffs/handoffs.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { NodeOperatorsModule } from './modules/node-operators/node-operators.module';
import { NodesModule } from './modules/nodes/nodes.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RidersModule } from './modules/riders/riders.module';

@Module({
  imports: [
    ConfigModule,
    CommonModule,
    DatabaseModule,
    HealthModule,
    NotificationsModule,
    IdentityModule,
    NodesModule,
    NodeOperatorsModule,
    RidersModule,
    OrdersModule,
    PaymentsModule,
    HandoffsModule,
    EarningsModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
