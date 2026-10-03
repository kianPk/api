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
}
