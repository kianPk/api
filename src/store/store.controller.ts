import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { User } from "../auth/types/User";
import { BaleConfig } from "../configs/types/BaleConfig";
import { StoreService } from "./store.service";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";

@Controller("store")
export class StoreController {
  private readonly bale: BaleConfig;

  constructor(
    private readonly store: StoreService,
    private readonly configService: ConfigService,
  ) {
    this.bale = this.configService.get<BaleConfig>("bale");
  }

  @Get("status")
  public status() {
    return this.store.getPublicStatus();
  }

  @Post("checkout")
  public async checkout(
    @Req() request: Request,
    @Body() body: { productId?: string },
  ) {
    const user = this.requireUser(request);
    if (!body?.productId) {
      throw new BadRequestException("productId required");
    }
    return this.store.checkout(body.productId, user.steam_id);
  }

  @Post("bale-webhook")
  public async baleWebhook(
    @Headers("x-bale-webhook-secret") secretHeader: string | undefined,
    @Body() body: any,
  ) {
    if (this.bale.webhookSecret) {
      const ok = timingSafeStringEqual(
        secretHeader || "",
        this.bale.webhookSecret,
      );
      if (!ok) {
        throw new UnauthorizedException("Invalid webhook secret");
      }
    }
    return this.store.handleWebhookUpdate(body);
  }

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    return user;
  }
}
