import {
  Controller,
  Get,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { ChallengesService } from "./challenges.service";

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
}
