import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { DemoQueues } from "../enums/DemoQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";
import { DemoMetadataService } from "../demo-metadata.service";

/**
 * Daily full wipe of demo/playback files so the panel S3 bucket stays small.
 * Match rows and player ELO are left alone — use PurgeOldMatchesDaily for Watch.
 */
@UseQueue("Demos", DemoQueues.Demos)
export class PurgeAllDemosDaily extends WorkerHost {
  constructor(
    private readonly demoMetadata: DemoMetadataService,
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }

  async process(): Promise<number> {
    if (!(await this.isEnabled())) {
      return 0;
    }

    const result = await this.demoMetadata.deleteAllDemos();
    this.logger.log(
      `[purge-demos-daily] removed ${result.objects} S3 object(s), ${result.rows} demo row(s)`,
    );
    return result.rows;
  }

  private async isEnabled(): Promise<boolean> {
    const { settings } = await this.hasura.query({
      settings: {
        __args: { where: { name: { _eq: "demo_purge_daily" } } },
        value: true,
      },
    });
    const raw = (settings.at(0)?.value || "true").trim().toLowerCase();
    return raw === "true" || raw === "1" || raw === "yes";
  }
}
