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

  async process(job: Job<{ limit?: number; force?: boolean }>): Promise<void> {
    if (!this.faceit.isEnabled()) {
      this.logger.debug("faceit ranks refresh skipped — FACEIT_API_KEY unset");
      return;
    }
    const limit = Math.min(120, Math.max(1, Number(job.data?.limit) || 40));
    const force = job.data?.force === true;
    const result = await this.faceit.refreshStalePlayers(limit, force);
    this.logger.log(
      `faceit ranks refresh: checked=${result.checked} updated=${result.updated} missing=${result.missing}`,
    );
  }
}
