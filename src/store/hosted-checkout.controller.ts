import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { StoreService } from "./store.service";

// Lives under /hosted-servers because the API ingress does not route /store.
@Controller("hosted-servers")
export class HostedCheckoutController {
  constructor(private readonly store: StoreService) {}

  @Post("checkout")
  public async checkout(
    @Req() request: Request,
    @Body()
    body: {
      productId?: string;
      hostedServerId?: string;
      type?: string;
      label?: string;
      termsAccepted?: boolean;
      payWith?: "bale" | "ypoint";
    },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    if (!body?.productId) {
      throw new BadRequestException("productId required");
    }
    return this.store.checkoutHosted(body.productId, user.steam_id, {
      termsAccepted: Boolean(body?.termsAccepted),
      hostedServerId: body.hostedServerId || undefined,
      type: body.type,
      label: body.label,
      payWith: body.payWith === "ypoint" ? "ypoint" : "bale",
    });
  }

  @Post("slots-checkout")
  public async slotsCheckout(
    @Req() request: Request,
    @Body()
    body: {
      hostedServerId?: string;
      count?: number;
      termsAccepted?: boolean;
      payWith?: "bale" | "ypoint";
    },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    if (!body?.hostedServerId) {
      throw new BadRequestException("hostedServerId required");
    }
    return this.store.checkoutHostedSlots(body.hostedServerId, user.steam_id, {
      count: Number(body.count),
      termsAccepted: Boolean(body.termsAccepted),
      payWith: body.payWith === "ypoint" ? "ypoint" : "bale",
    });
  }

  @Post("vip-shop/checkout")
  public async vipShopCheckout(
    @Req() request: Request,
    @Body()
    body: {
      server_id?: string;
      duration?: string;
      termsAccepted?: boolean;
    },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    if (!body?.server_id) {
      throw new BadRequestException("server_id required");
    }
    return this.store.checkoutHostedVipShop(body.server_id, user.steam_id, {
      duration: body.duration,
      termsAccepted: Boolean(body.termsAccepted),
    });
  }
}
