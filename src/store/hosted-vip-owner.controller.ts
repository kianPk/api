import {
  BadRequestException,
  Body,
  Controller,
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

/**
 * Owner-facing VIP management for a hosted public server.
 * Uses hosted_servers.id (not game servers.id). Platform admins allowed via requireOwner.
 */
@Controller("hosted-servers")
export class HostedVipOwnerController {
  constructor(
    private readonly store: StoreService,
    private readonly hosted: HostedServersService,
  ) {}

  @Get(":id/vips")
  public async list(@Req() request: Request, @Param("id") id: string) {
    const serverId = await this.resolveOwnerServerId(request, id);
    return { vips: await this.store.adminListVips(serverId) };
  }

  @Post(":id/vips/grant")
  public async grant(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: { steam_id?: string; duration?: string },
  ) {
    const serverId = await this.resolveOwnerServerId(request, id);
    return this.store.adminGrantVip(serverId, body?.steam_id, body?.duration);
  }

  @Post(":id/vips/revoke")
  public async revoke(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: { steam_id?: string },
  ) {
    const serverId = await this.resolveOwnerServerId(request, id);
    return this.store.adminRevokeVip(serverId, body?.steam_id);
  }

  @Post(":id/vips/sync")
  public async sync(@Req() request: Request, @Param("id") id: string) {
    const serverId = await this.resolveOwnerServerId(request, id);
    return this.store.adminSyncVips(serverId);
  }

  private async resolveOwnerServerId(
    request: Request,
    hostedId: string,
  ): Promise<string> {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    const hosted = await this.hosted.requireOwner(hostedId, user);
    if (hosted.status !== "active" || !hosted.server_id) {
      throw new BadRequestException(`Server is ${hosted.status}`);
    }
    return hosted.server_id;
  }
}
