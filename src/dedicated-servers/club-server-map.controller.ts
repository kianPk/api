import {
  Body,
  Controller,
  ForbiddenException,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { DedicatedServersService } from "./dedicated-servers.service";

@Controller("hosted-servers")
export class ClubServerMapController {
  constructor(private readonly dedicatedServers: DedicatedServersService) {}

  @Post("clubs/:clubId/servers/:serverId/map")
  public async changeClubServerMap(
    @Param("clubId") clubId: string,
    @Param("serverId") serverId: string,
    @Body() body: { map?: string },
    @Req() request: Request,
  ) {
    const user = request.user as User | undefined;
    if (!user) throw new ForbiddenException("Authentication required");
    return this.dedicatedServers.changeClubServerMap(
      clubId,
      serverId,
      String(body?.map || ""),
      user,
    );
  }
}
