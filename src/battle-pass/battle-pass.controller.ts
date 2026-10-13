import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { BattlePassService } from "./battle-pass.service";

@Controller("battle-pass")
export class BattlePassController {
  constructor(private readonly battlePass: BattlePassService) {}

  @Get("me")
  public async me(@Req() request: Request) {
    return this.battlePass.getMe(this.steamId(request));
  }

  @Post("claim")
  public async claim(
    @Req() request: Request,
    @Body() body: { level?: number; track?: string },
  ) {
    const level = Number(body?.level);
    if (!Number.isInteger(level)) {
      throw new BadRequestException("level required");
    }
    if (body?.track !== "free" && body?.track !== "premium") {
      throw new BadRequestException("track must be free or premium");
    }
    return this.battlePass.claim(this.steamId(request), level, body.track);
  }

  @Post("claim-all")
  public async claimAll(@Req() request: Request) {
    return this.battlePass.claimAll(this.steamId(request));
  }

  @Post("premium")
  public async buyPremium(@Req() request: Request) {
    return this.battlePass.buyPremium(this.steamId(request));
  }

  private steamId(request: Request): string {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    return String(user.steam_id);
  }
}
