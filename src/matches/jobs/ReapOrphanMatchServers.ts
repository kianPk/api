import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class ReapOrphanMatchServers extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly matchAssistant: MatchAssistantService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.matchAssistant.reapOrphanMatchServers();
    } catch (error) {
      this.logger.error(
        `ReapOrphanMatchServers failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
