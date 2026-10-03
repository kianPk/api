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
import { StoreService } from "./store.service";

// Lives under /hosted-servers because the API ingress does not route /store.
@Controller("hosted-servers/vip")
export class VipAdminController {
  constructor(private readonly store: StoreService) {}

  @Get(":serverId")
  public async list(
    @Req() request: Request,
    @Param("serverId") serverId: string,
  ) {
    this.requireAdmin(request);
    return this.store.adminListVips(serverId);
  }

  @Post(":serverId/grant")
  public async grant(
    @Req() request: Request,
    @Param("serverId") serverId: string,
    @Body() body: { steam_id?: string; duration?: string },
  ) {
    this.requireAdmin(request);
    return this.store.adminGrantVip(serverId, body?.steam_id, body?.duration);
  }

  @Post(":serverId/revoke")
  public async revoke(
    @Req() request: Request,
    @Param("serverId") serverId: string,
    @Body() body: { steam_id?: string },
  ) {
    this.requireAdmin(request);
    return this.store.adminRevokeVip(serverId, body?.steam_id);
  }

  @Post(":serverId/sync")
  public async sync(
    @Req() request: Request,
    @Param("serverId") serverId: string,
  ) {
    this.requireAdmin(request);
    return this.store.adminSyncVips(serverId);
  }

  private requireAdmin(request: Request) {
    const user = request.user as User | undefined;
    if (user?.role !== "administrator") {
      throw new ForbiddenException("Administrator access required");
    }
  }
}
