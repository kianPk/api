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
import { Request } from "express";
import { User } from "../auth/types/User";
import { StoreService } from "./store.service";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";

@Controller("store")
export class StoreController {
  constructor(private readonly store: StoreService) {}

  @Get("status")
  public async status() {
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

  @Post("cancel-pending")
  public async cancelPending(
    @Req() request: Request,
    @Body() body: { exceptOrderId?: string },
  ) {
    const user = this.requireUser(request);
    return this.store.cancelPendingOrders(user.steam_id, body?.exceptOrderId);
  }

  @Post("bale-webhook")
  public async baleWebhook(
    @Headers("x-bale-webhook-secret") secretHeader: string | undefined,
    @Body() body: any,
  ) {
    const webhookSecret = await this.store.getWebhookSecret();
    if (webhookSecret) {
      const ok = timingSafeStringEqual(secretHeader || "", webhookSecret);
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
