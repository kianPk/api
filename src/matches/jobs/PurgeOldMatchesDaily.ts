import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";
import { DemoMetadataService } from "../../demos/demo-metadata.service";
import { ClipsService } from "../clips/clips.service";

/**
 * Removes finished non-tournament matches older than N hours from Watch/history.
 * player_elo rows survive via ON DELETE SET NULL on match_id (migration
 * 1899000000000_daily_purge_preserve_elo), so ratings stay.
 */
@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class PurgeOldMatchesDaily extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly demoMetadata: DemoMetadataService,
    private readonly clips: ClipsService,
  ) {
    super();
  }

  async process(): Promise<number> {
    if (!(await this.isEnabled())) {
      return 0;
    }

    const hours = await this.purgeAfterHours();
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    let removed = 0;
    // Cap total work per run so a huge backlog cannot starve the worker.
    const maxPerRun = 1000;

    while (removed < maxPerRun) {
      const { matches } = await this.hasura.query({
        matches: {
          __args: {
            where: {
              _and: [
                { is_tournament_match: { _eq: false } },
                { status: { _eq: "Finished" } },
                { ended_at: { _lt: cutoff } },
              ],
            },
            limit: 100,
            order_by: [{ ended_at: "asc" }],
          },
          id: true,
        },
      });

      if (matches.length === 0) {
        break;
      }

      for (const match of matches) {
        if (removed >= maxPerRun) {
          break;
        }
        try {
          await this.clips.deleteClipsForMatch(match.id);
          await this.demoMetadata.deleteDemosForMatch(match.id);
          await this.hasura.mutation({
            delete_matches_by_pk: {
              __args: { id: match.id },
              __typename: true,
            },
          });
          removed++;
        } catch (error) {
          this.logger.warn(
            `[purge-matches-daily] ${match.id} failed: ${(error as Error)?.message}`,
          );
        }
      }

      if (matches.length < 100) {
        break;
      }
    }

    if (removed > 0) {
      this.logger.log(
        `[purge-matches-daily] removed ${removed} finished match(es) older than ${hours}h (ELO preserved)`,
      );
    }

    return removed;
  }

  private async isEnabled(): Promise<boolean> {
    const { settings } = await this.hasura.query({
      settings: {
        __args: { where: { name: { _eq: "match_purge_daily" } } },
        value: true,
      },
    });
    const raw = (settings.at(0)?.value || "true").trim().toLowerCase();
    return raw === "true" || raw === "1" || raw === "yes";
  }

  private async purgeAfterHours(): Promise<number> {
    const { settings } = await this.hasura.query({
      settings: {
        __args: { where: { name: { _eq: "match_purge_after_hours" } } },
        value: true,
      },
    });
    const parsed = parseInt(settings.at(0)?.value || "24", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
  }
}
