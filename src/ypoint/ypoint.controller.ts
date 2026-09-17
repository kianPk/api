import { Controller, Get, Req, UnauthorizedException } from "@nestjs/common";
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
}
