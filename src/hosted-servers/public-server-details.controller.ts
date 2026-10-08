import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { PublicServerDetailsService } from "./public-server-details.service";

@Controller("hosted-servers")
export class PublicServerDetailsController {
  constructor(private readonly details: PublicServerDetailsService) {}

  @Get("public-details/:serverId")
  public async get(
    @Req() request: Request,
    @Param("serverId") serverId: string,
  ) {
    const user = request.user as User | undefined;
    return this.details.getDetails(serverId, user);
  }

  @Post("public-details/:serverId/settings")
  public async settings(
    @Req() request: Request,
    @Param("serverId") serverId: string,
    @Body()
    body: {
      show_vips?: boolean;
      show_ranks?: boolean;
      show_bans?: boolean;
    },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    return this.details.updateSettings(serverId, user, body || {});
  }

  /** Owner / site admin: set a player's points (or skill group) on this box. */
  @Post("public-details/:serverId/ranks/set")
  public async setRank(
    @Req() request: Request,
    @Param("serverId") serverId: string,
    @Body()
    body: {
      steam_id?: string;
      points?: number;
      skill_group?: number;
      name?: string;
    },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    return this.details.setPlayerRank(serverId, user, body || {});
  }

  @Post("plugin/server-bans/sync")
  public async pluginBanSync(
    @Headers("authorization") authorization: string,
    @Body()
    body: {
      server_id?: string;
      bans?: Array<{
        steam_id?: string;
        name?: string;
        reason?: string;
        expires_at?: string | null;
      }>;
    },
  ) {
    return this.details.pluginSyncBans(authorization, body || {});
  }
}
