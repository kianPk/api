import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Logger,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { Request } from "express";
import { HasuraAction } from "../hasura/hasura.controller";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { User } from "../auth/types/User";
import { FaceitService } from "./faceit.service";
import { FaceitMatchImportService } from "./faceit-match-import.service";
import { FaceitQueues } from "./enums/FaceitQueues";
import { RefreshFaceitRanks } from "./jobs/RefreshFaceitRanks";

@Controller("faceit")
export class FaceitController {
  constructor(
    private readonly faceitService: FaceitService,
    private readonly faceitImport: FaceitMatchImportService,
    private readonly logger: Logger,
    @InjectQueue(FaceitQueues.RefreshFaceitRanks)
    private readonly ranksQueue: Queue,
  ) {}

  @HasuraAction()
  public async refreshFaceitRank(data: {
    steam_id: string;
  }): Promise<{ success: boolean }> {
    if (!data.steam_id || !/^\d{5,20}$/.test(data.steam_id)) {
      throw new BadRequestException("invalid steam_id");
    }

    if (!this.faceitService.isEnabled()) {
      return { success: false };
    }

    const refreshed = await this.faceitService.refreshPlayer(data.steam_id);
    return { success: refreshed };
  }

  @Post("import")
  @UseGuards(SteamGuard)
  public async importMatch(
    @Req() request: Request,
    @Body() body: { url?: string },
  ): Promise<{ queued: boolean; match_id: string }> {
    await this.assertCanImport(request);

    const matchId = FaceitService.extractMatchId(body.url ?? "");
    if (!matchId) {
      throw new BadRequestException(
        "expected a FACEIT room url or match id (1-<uuid>)",
      );
    }

    await this.faceitImport.enqueueMatch(matchId);
    this.logger.log(`faceit import queued faceit_match_id=${matchId}`);

    return { queued: true, match_id: matchId };
  }

  @HasuraAction()
  public async testFaceitIntegration(data: { user?: User }): Promise<{
    dataApi: { ok: boolean; detail: string };
    downloadApi: { ok: boolean | null; detail: string };
  }> {
    if (!data.user) {
      throw new ForbiddenException("authentication required");
    }
    if (data.user.role !== "administrator") {
      throw new ForbiddenException("administrator access required");
    }
    return this.faceitService.testIntegration(data.user.steam_id);
  }

  /** Admin: queue a larger FACEIT rank backfill for active players. */
  @HasuraAction()
  public async syncFaceitRanks(data: {
    user?: User;
    limit?: number;
    force?: boolean;
  }): Promise<{ success: boolean; limit: number }> {
    if (!data.user) {
      throw new ForbiddenException("authentication required");
    }
    if (data.user.role !== "administrator") {
      throw new ForbiddenException("administrator access required");
    }
    if (!this.faceitService.isEnabled()) {
      throw new ForbiddenException("FACEIT_API_KEY not configured");
    }
    const limit = Math.min(120, Math.max(1, Number(data?.limit) || 80));
    await this.ranksQueue.add(
      RefreshFaceitRanks.name,
      { limit, force: data?.force !== false },
      { removeOnComplete: 20, removeOnFail: 20 },
    );
    this.logger.log(`faceit ranks refresh queued limit=${limit}`);
    return { success: true, limit };
  }

  /** Kept for in-cluster / future ingress; browser should use syncFaceitRanks. */
  @Post("refresh-ranks")
  @UseGuards(SteamGuard)
  public async refreshRanks(
    @Req() request: Request,
    @Body() body: { limit?: number; force?: boolean },
  ): Promise<{ queued: boolean; limit: number }> {
    const result = await this.syncFaceitRanks({
      user: request.user,
      limit: body?.limit,
      force: body?.force,
    });
    return { queued: result.success, limit: result.limit };
  }

  private async assertCanImport(request: Request): Promise<User> {
    if (!request.user) {
      throw new ForbiddenException("authentication required");
    }
    if (request.user.role !== "administrator") {
      throw new ForbiddenException("administrator access required");
    }
    if (!this.faceitService.isEnabled()) {
      throw new ForbiddenException("FACEIT_API_KEY not configured");
    }
    if (!(await this.faceitImport.isImportingAllowed())) {
      throw new ForbiddenException("external match imports are disabled");
    }
    if (!(await this.faceitImport.isFaceitImportEnabled())) {
      throw new ForbiddenException("faceit match imports are disabled");
    }
    return request.user;
  }
}
