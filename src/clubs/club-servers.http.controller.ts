import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { ClubsService } from "./clubs.service";

// /hosted-servers is already on the public ingress. /clubs is not, so a
// browser call there never gets a response.
@Controller("hosted-servers")
export class ClubServersHttpController {
  constructor(private readonly clubs: ClubsService) {}

  @Get("clubs/:clubId/servers")
  public async list(@Param("clubId") clubId: string, @Req() request: Request) {
    return this.clubs.listClubServers(clubId, request.user as User | undefined);
  }

  @Post("clubs/:clubId/servers/settings")
  public async saveSettings(
    @Param("clubId") clubId: string,
    @Body()
    body: {
      mode?: string;
      count?: number;
      maps?: Array<{ id?: string; name?: string }>;
    },
    @Req() request: Request,
  ) {
    const user = request.user as User | undefined;
    if (!user) throw new ForbiddenException("Authentication required");
    return this.clubs.saveClubServerSettings(clubId, user, body || {});
  }

  @Post("clubs/:clubId/servers/mode")
  public async setMode(
    @Param("clubId") clubId: string,
    @Body() body: { mode?: string },
    @Req() request: Request,
  ) {
    const user = request.user as User | undefined;
    if (!user) throw new ForbiddenException("Authentication required");
    return this.clubs.setClubServerMode(clubId, String(body?.mode || ""), user);
  }
}
