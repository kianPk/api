import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { FaceitQueues } from "../enums/FaceitQueues";
import { FaceitService } from "../faceit.service";

@UseQueue("Faceit", FaceitQueues.RefreshFaceitRanks, {
  concurrency: 1,
  limiter: { max: 1, duration: 5_000 },
})
export class RefreshFaceitRanks extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly faceit: FaceitService,
  ) {
    super();
  }

  async process(
    job: Job<{
      limit?: number;
      force?: boolean;
      steamIds?: string[];
    }>,
  ): Promise<void> {
    if (!this.faceit.isEnabled()) {
      this.logger.debug("faceit ranks refresh skipped — FACEIT_API_KEY unset");
      return;
    }
    const force = job.data?.force === true;
    const steamIds = (job.data?.steamIds ?? [])
      .map((id) => String(id || ""))
      .filter((id) => /^\d{5,20}$/.test(id));

    if (steamIds.length) {
      let updated = 0;
      for (const steamId of steamIds) {
        try {
          if (await this.faceit.refreshPlayer(steamId, force)) {
            updated += 1;
          }
        } catch (error) {
          this.logger.warn(
            `faceit rank refresh failed for ${steamId}: ${
              error instanceof Error ? error.message : error
            }`,
          );
        }
      }
      this.logger.log(
        `faceit ranks refresh (targeted): checked=${steamIds.length} updated=${updated}`,
      );
      return;
    }

    const limit = Math.min(120, Math.max(1, Number(job.data?.limit) || 40));
    const result = await this.faceit.refreshStalePlayers(limit, force);
    this.logger.log(
      `faceit ranks refresh: checked=${result.checked} updated=${result.updated} missing=${result.missing}`,
    );
  }
}
