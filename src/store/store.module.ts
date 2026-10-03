import { Module } from "@nestjs/common";
import { StoreController } from "./store.controller";
import { HostedCheckoutController } from "./hosted-checkout.controller";
import { VipAdminController } from "./vip-admin.controller";
import { StoreService } from "./store.service";
import { PostgresModule } from "../postgres/postgres.module";
import { S3Module } from "../s3/s3.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { YpointModule } from "../ypoint/ypoint.module";
import { RconModule } from "../rcon/rcon.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ChallengesModule } from "../challenges/challenges.module";
import { HostedServersModule } from "../hosted-servers/hosted-servers.module";

@Module({
  imports: [
    PostgresModule,
    S3Module,
    YpointModule,
    RconModule,
    NotificationsModule,
    ChallengesModule,
    HostedServersModule,
  ],
  controllers: [StoreController, HostedCheckoutController, VipAdminController],
  providers: [StoreService, loggerFactory()],
  exports: [StoreService],
})
export class StoreModule {}
