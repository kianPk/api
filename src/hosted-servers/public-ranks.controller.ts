import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
} from "@nestjs/common";
import { PublicRanksService } from "./public-ranks.service";

// Under /hosted-servers because the API ingress does not route arbitrary paths.
@Controller("hosted-servers")
export class PublicRanksController {
  constructor(private readonly ranks: PublicRanksService) {}

  @Get("plugin/ranks/players")
  public async players(
    @Headers("authorization") authorization: string,
    @Query("server_id") serverId: string,
    @Query("steam_ids") steamIds: string,
  ) {
    const sid = String(serverId || "");
    await this.ranks.authenticateServer(sid, authorization);
    const ids = String(steamIds || "")
      .split(/[,\s]+/)
      .filter(Boolean);
    return { players: await this.ranks.getPlayers(ids, sid) };
  }

  @Get("plugin/ranks/top")
  public async top(
    @Headers("authorization") authorization: string,
    @Query("server_id") serverId: string,
    @Query("limit") limit?: string,
  ) {
    await this.ranks.authenticateServer(String(serverId || ""), authorization);
    return {
      players: await this.ranks.serverLeaderboard(
        String(serverId || ""),
        Number(limit),
      ),
    };
  }

  @Post("plugin/ranks/sync")
  public async sync(
    @Headers("authorization") authorization: string,
    @Body()
    body: {
      server_id?: string;
      events?: Array<{
        steam_id?: string;
        name?: string;
        delta_points?: number;
        kills?: number;
        deaths?: number;
        assists?: number;
        headshots?: number;
      }>;
    },
  ) {
    await this.ranks.authenticateServer(
      String(body?.server_id || ""),
      authorization,
    );
    if (!Array.isArray(body?.events)) {
      throw new BadRequestException("events required");
    }
    return {
      players: await this.ranks.applyDeltas(
        body.events,
        String(body?.server_id || ""),
      ),
    };
  }

  /** Public read for the site — no auth. */
  @Get("ranks/leaderboard")
  public async publicLeaderboard(@Query("limit") limit?: string) {
    return {
      players: await this.ranks.leaderboard(Number(limit) || 25),
      thresholds: this.ranks.thresholds(),
    };
  }
}
