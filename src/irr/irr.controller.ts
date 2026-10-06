import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { IrrService } from "./irr.service";

@Controller("irr")
export class IrrController {
  constructor(private readonly irr: IrrService) {}

  @Get("me")
  public async me(@Req() request: Request) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    const balance = await this.irr.getBalance(user.steam_id);
    return { balance };
  }

  @Get("admin/balances")
  public async adminBalances(
    @Req() request: Request,
    @Query("limit") limit?: string,
  ) {
    this.requireAdmin(request);
    const players = await this.irr.listBalances(limit ? Number(limit) : 50);
    return {
      players: players.map((p) => ({
        steam_id: p.steam_id,
        name: p.name,
        avatar_url: p.avatar_url,
        irr_balance: Number(p.irr_balance),
      })),
    };
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
