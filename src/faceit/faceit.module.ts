import { Module, forwardRef } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { CacheModule } from "../cache/cache.module";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { DemosModule } from "../demos/demos.module";
import { SteamMatchHistoryModule } from "../steam-match-history/steam-match-history.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { FaceitController } from "./faceit.controller";
import { FaceitService } from "./faceit.service";
import { FaceitMatchImportService } from "./faceit-match-import.service";
import { FaceitQueues } from "./enums/FaceitQueues";
import { PollAllFaceitMatchHistory } from "./jobs/PollAllFaceitMatchHistory";
import { ImportFaceitMatch } from "./jobs/ImportFaceitMatch";
import { RefreshFaceitRanks } from "./jobs/RefreshFaceitRanks";

@Module({
  imports: [
    BullModule.registerQueue({
      name: FaceitQueues.PollAllFaceitMatchHistory,
    }),
    BullModule.registerQueue({
      name: FaceitQueues.ImportFaceitMatch,
    }),
    BullModule.registerQueue({
      name: FaceitQueues.RefreshFaceitRanks,
    }),
    BullBoardModule.forFeature({
      name: FaceitQueues.PollAllFaceitMatchHistory,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: FaceitQueues.ImportFaceitMatch,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: FaceitQueues.RefreshFaceitRanks,
      adapter: BullMQAdapter,
    }),
    CacheModule,
    HasuraModule,
    PostgresModule,
    DemosModule,
    forwardRef(() => SteamMatchHistoryModule),
  ],
  controllers: [FaceitController],
  providers: [
    loggerFactory(),
    FaceitService,
    FaceitMatchImportService,
    PollAllFaceitMatchHistory,
    ImportFaceitMatch,
    RefreshFaceitRanks,
    ...getQueuesProcessors("Faceit"),
  ],
  exports: [FaceitService],
})
export class FaceitModule {
  constructor(
    @InjectQueue(FaceitQueues.PollAllFaceitMatchHistory)
    pollQueue: Queue,
    @InjectQueue(FaceitQueues.RefreshFaceitRanks)
    ranksQueue: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void pollQueue.add(
      PollAllFaceitMatchHistory.name,
      {},
      {
        repeat: {
          pattern: "30 * * * *",
        },
      },
    );

    // Backfill FACEIT levels for active players (not only on profile visit).
    void ranksQueue.add(
      RefreshFaceitRanks.name,
      { limit: 40 },
      {
        repeat: {
          pattern: "*/10 * * * *",
        },
      },
    );
  }
}
