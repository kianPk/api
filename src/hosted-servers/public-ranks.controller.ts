import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { PublicRanksService } from "./public-ranks.service";
import { SectionRatingsService } from "./section-ratings.service";
import { SiteXpService } from "../site-xp/site-xp.service";
import { SiteXpInput } from "../site-xp/site-xp";

// Under /hosted-servers because the API ingress does not route arbitrary paths.
@Controller("hosted-servers")
export class PublicRanksController {
  constructor(
    private readonly ranks: PublicRanksService,
    private readonly sectionRatings: SectionRatingsService,
    private readonly siteXp: SiteXpService,
  ) {}

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

  // Faceit-style Elo for Servers-section modes (duels, dm). Auth is the
  // game pod's SERVER_API_PASSWORD, same as plugin/ranks/*.
  @Get("plugin/section-ratings/:mode")
  public async sectionRatingsGet(
    @Headers("authorization") authorization: string,
    @Param("mode") mode: string,
    @Query("server_id") serverId: string,
    @Query("steam_ids") steamIds: string,
  ) {
    await this.sectionRatings.authenticateServer(
      String(serverId || ""),
      authorization,
    );
    const key = this.sectionRatings.assertMode(mode);
    const ids = String(steamIds || "")
      .split(/[,\s]+/)
      .filter(Boolean);
    return { players: await this.sectionRatings.get(key, ids) };
  }

  @Post("plugin/section-ratings/:mode")
  public async sectionRatingsPut(
    @Headers("authorization") authorization: string,
    @Param("mode") mode: string,
    @Body()
    body: {
      server_id?: string;
      players?: Array<{ steam_id?: string; rating?: number; name?: string }>;
    },
  ) {
    await this.sectionRatings.authenticateServer(
      String(body?.server_id || ""),
      authorization,
    );
    const key = this.sectionRatings.assertMode(mode);
    if (!Array.isArray(body?.players)) {
      throw new BadRequestException("players required");
    }
    return {
      players: await this.sectionRatings.upsert(key, body.players),
    };
  }

  /** Public site read — only players who already have a stored section rating. */
  @Get("section-ratings/:mode")
  public async sectionRatingsPublicGet(
    @Param("mode") mode: string,
    @Query("steam_ids") steamIds: string,
  ) {
    const key = this.sectionRatings.assertMode(mode);
    const ids = String(steamIds || "")
      .split(/[,\s]+/)
      .filter(Boolean);
    return { players: await this.sectionRatings.getExisting(key, ids) };
  }

  @Get("site-xp/top")
  public async siteXpTop(@Query("limit") limit: string) {
    return { players: await this.siteXp.top(Number(limit)) };
  }

  @Get("site-xp")
  @Header("Cache-Control", "no-store")
  public async siteXpGet(@Query("steam_ids") steamIds: string) {
    const ids = String(steamIds || "")
      .split(/[,\s]+/)
      .filter(Boolean);
    return { players: await this.siteXp.get(ids) };
  }

  @Post("plugin/site-xp")
  public async siteXpPost(
    @Headers("authorization") authorization: string,
    @Body()
    body: {
      server_id?: string;
      events?: SiteXpInput[];
    },
  ) {
    await this.ranks.authenticateServer(
      String(body?.server_id || ""),
      authorization,
    );
    if (!Array.isArray(body?.events)) {
      throw new BadRequestException("events required");
    }
    return { players: await this.siteXp.applyMany(body.events) };
  }

  @Post("site-xp/admin-set")
  public async siteXpAdminSet(
    @Req() request: Request,
    @Body() body: { steam_id?: string; level?: number },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    return { player: await this.siteXp.adminSetLevel(user, body || {}) };
  }

  // Site admin: set Faceit-style level for a player on a Servers-section mode.
  @Post("section-ratings/:mode/admin-set")
  public async sectionRatingsAdminSet(
    @Req() request: Request,
    @Param("mode") mode: string,
    @Body()
    body: { steam_id?: string; level?: number; name?: string },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    return {
      player: await this.sectionRatings.adminSetLevel(user, mode, body || {}),
    };
  }
}
