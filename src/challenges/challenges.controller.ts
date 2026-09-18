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
import { ChallengesService } from "./challenges.service";
import type { ChallengeTier } from "./challenge-catalog";

@Controller("challenges")
export class ChallengesController {
  constructor(private readonly challenges: ChallengesService) {}

  @Get("me")
  public async me(@Req() request: Request) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    return this.challenges.getMyChallenges(String(user.steam_id));
  }

  @Get("admin/subscriptions")
  public async adminList(
    @Req() request: Request,
    @Query("limit") limit?: string,
  ) {
    this.requireAdmin(request);
    const rows = await this.challenges.adminListSubscriptions(
      limit ? Number(limit) : 100,
    );
    return { subscriptions: rows };
  }

  @Get("admin/subscription")
  public async adminGetOne(
    @Req() request: Request,
    @Query("steamId") steamId?: string,
  ) {
    this.requireAdmin(request);
    if (!steamId) throw new BadRequestException("steamId required");
    const subscription = await this.challenges.adminGetSubscription(
      String(steamId),
    );
    return { subscription };
  }

  @Post("admin/grant")
  public async adminGrant(
    @Req() request: Request,
    @Body()
    body: {
      steamId?: string;
      tier?: ChallengeTier;
      duration?: string;
      mode?: "extend" | "set";
      note?: string;
    },
  ) {
    const admin = this.requireAdmin(request);
    if (!body?.steamId) throw new BadRequestException("steamId required");
    if (body.tier !== "premium" && body.tier !== "premium_plus") {
      throw new BadRequestException("tier must be premium or premium_plus");
    }
    const result = await this.challenges.adminGrantSubscription({
      steamId: String(body.steamId),
      tier: body.tier,
      duration: body.duration || "30d",
      mode: body.mode === "set" ? "set" : "extend",
      adminSteamId: String(admin.steam_id),
      note: body.note,
    });
    return { success: true, subscription: result };
  }

  @Post("admin/revoke")
  public async adminRevoke(
    @Req() request: Request,
    @Body() body: { steamId?: string; note?: string },
  ) {
    const admin = this.requireAdmin(request);
    if (!body?.steamId) throw new BadRequestException("steamId required");
    await this.challenges.adminRevokeSubscription({
      steamId: String(body.steamId),
      adminSteamId: String(admin.steam_id),
      note: body.note,
    });
    return { success: true };
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
