import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { YpointService } from "./ypoint.service";

@Controller("ypoint")
export class YpointController {
  constructor(private readonly ypoint: YpointService) {}

  @Get("me")
  public async me(@Req() request: Request) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    const [balance, costs] = await Promise.all([
      this.ypoint.getBalance(user.steam_id),
      this.ypoint.getCosts(),
    ]);
    return { balance, costs };
  }

  @Get("costs")
  public async costs() {
    return this.ypoint.getCosts();
  }

  @Get("admin/players")
  public async adminPlayers(
    @Req() request: Request,
    @Query("q") q?: string,
  ) {
    this.requireAdmin(request);
    if (!q?.trim()) {
      return { players: [] };
    }
    const players = await this.ypoint.findPlayers(q);
    return { players };
  }

  @Post("admin/adjust")
  public async adminAdjust(
    @Req() request: Request,
    @Body()
    body: {
      steamId?: string;
      delta?: number;
      note?: string;
    },
  ) {
    const admin = this.requireAdmin(request);
    if (!body?.steamId) {
      throw new BadRequestException("steamId required");
    }
    if (body.delta === undefined || body.delta === null) {
      throw new BadRequestException("delta required");
    }
    const result = await this.ypoint.adminAdjust({
      targetSteamId: String(body.steamId),
      delta: Number(body.delta),
      adminSteamId: String(admin.steam_id),
      note: body.note,
    });
    return { success: true, ...result };
  }

  private requireAdmin(request: Request): User {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new ForbiddenException("Authentication required");
    }
    if (user.role !== "administrator") {
      throw new ForbiddenException("Administrator access required");
    }
    return user;
  }
}
