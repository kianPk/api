import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { HostedServersService } from "../hosted-servers/hosted-servers.service";
import { StoreService } from "./store.service";

// Lives under /hosted-servers because the API ingress does not route /store.
// Platform admins and the hosted public-server owner can manage VIP.
@Controller("hosted-servers/vip")
export class VipAdminController {
  constructor(
    private readonly store: StoreService,
    private readonly hosted: HostedServersService,
  ) {}

  @Get(":serverId")
  public async list(
    @Req() request: Request,
    @Param("serverId") serverId: string,
  ) {
    await this.requireVipManager(request, serverId);
    return this.store.adminListVips(serverId);
  }

  @Post(":serverId/grant")
  public async grant(
    @Req() request: Request,
    @Param("serverId") serverId: string,
    @Body() body: { steam_id?: string; duration?: string },
  ) {
    await this.requireVipManager(request, serverId);
    return this.store.adminGrantVip(serverId, body?.steam_id, body?.duration);
  }

  @Post(":serverId/revoke")
  public async revoke(
    @Req() request: Request,
    @Param("serverId") serverId: string,
    @Body() body: { steam_id?: string },
  ) {
    await this.requireVipManager(request, serverId);
    return this.store.adminRevokeVip(serverId, body?.steam_id);
  }

  @Post(":serverId/sync")
  public async sync(
    @Req() request: Request,
    @Param("serverId") serverId: string,
  ) {
    await this.requireVipManager(request, serverId);
    return this.store.adminSyncVips(serverId);
  }

  private async requireVipManager(request: Request, serverId: string) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    if (user.role === "administrator") {
      return;
    }
    if (!(await this.hosted.isOwnerOfGameServer(serverId, user.steam_id))) {
      throw new ForbiddenException("Only the server owner can manage VIP");
    }
  }
}
