import { Module } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { PostgresModule } from "../postgres/postgres.module";
import { HasuraModule } from "../hasura/hasura.module";
import { RconModule } from "../rcon/rcon.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { DedicatedServersModule } from "../dedicated-servers/dedicated-servers.module";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { loggerFactory } from "../utilities/LoggerFactory";
import { HostedServerQueues } from "./enums/HostedServerQueues";
import { ProcessHostedServers } from "./jobs/ProcessHostedServers";
import { HostedServersService } from "./hosted-servers.service";
import { HostedServersController } from "./hosted-servers.controller";
import { PublicRanksService } from "./public-ranks.service";
import { PublicRanksController } from "./public-ranks.controller";

@Module({
  imports: [
    PostgresModule,
    HasuraModule,
    RconModule,
    NotificationsModule,
    DedicatedServersModule,
    BullModule.registerQueue({
      name: HostedServerQueues.Lifecycle,
    }),
    BullBoardModule.forFeature({
      name: HostedServerQueues.Lifecycle,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [HostedServersController, PublicRanksController],
  providers: [
    HostedServersService,
    PublicRanksService,
    ProcessHostedServers,
    ...getQueuesProcessors("HostedServers"),
    loggerFactory(),
  ],
  exports: [HostedServersService, PublicRanksService],
})
export class HostedServersModule {
  constructor(
    @InjectQueue(HostedServerQueues.Lifecycle) lifecycleQueue: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void lifecycleQueue.add(
      ProcessHostedServers.name,
      {},
      {
        repeat: {
          pattern: "*/5 * * * *",
        },
      },
    );
  }
}
