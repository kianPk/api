import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { GamenetService } from "./gamenet.service";

// Under /hosted-servers so the live API ingress routes it (same as site-xp).
@Controller("hosted-servers/gamenet")
export class GamenetController {
  constructor(private readonly gamenet: GamenetService) {}

  @Get("admin/codes")
  public async adminList(@Req() request: Request) {
    this.gamenet.assertAdmin(request.user as User | undefined);
    return { codes: await this.gamenet.listCodes() };
  }

  @Post("admin/codes")
  public async adminCreate(
    @Req() request: Request,
    @Body()
    body: {
      label?: string;
      note?: string;
      club_id?: string | null;
      max_devices?: number;
      code?: string;
    },
  ) {
    const user = this.gamenet.assertAdmin(request.user as User | undefined);
    return { code: await this.gamenet.createCode(user, body || {}) };
  }

  @Delete("admin/codes/:id")
  public async adminRevokeCode(
    @Req() request: Request,
    @Param("id") id: string,
  ) {
    const user = this.gamenet.assertAdmin(request.user as User | undefined);
    return this.gamenet.revokeCode(user, id);
  }

  @Get("admin/codes/:id/devices")
  public async adminDevices(
    @Req() request: Request,
    @Param("id") id: string,
  ) {
    this.gamenet.assertAdmin(request.user as User | undefined);
    return { devices: await this.gamenet.listDevices(id) };
  }

  @Delete("admin/devices/:id")
  public async adminRevokeDevice(
    @Req() request: Request,
    @Param("id") id: string,
  ) {
    const user = this.gamenet.assertAdmin(request.user as User | undefined);
    return this.gamenet.revokeDevice(user, id);
  }

  @Get("status")
  public async status(@Query("device_id") deviceId: string) {
    return this.gamenet.status(deviceId);
  }

  @Post("redeem")
  public async redeem(
    @Req() request: Request,
    @Body()
    body: { code?: string; device_id?: string; device_label?: string },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new ForbiddenException("Authentication required");
    }
    return this.gamenet.redeemCode(user, body || {});
  }

  @Post("heartbeat")
  public async heartbeat(
    @Req() request: Request,
    @Body() body: { device_id?: string },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new ForbiddenException("Authentication required");
    }
    return this.gamenet.heartbeat(user, body || {});
  }
}
