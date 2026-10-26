import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { ClubsService } from "./clubs.service";
import { ClubShopService } from "./club-shop.service";

// /hosted-servers is already on the public ingress. /clubs is not, so a
// browser call there never gets a response.
@Controller("hosted-servers")
export class ClubServersHttpController {
  constructor(
    private readonly clubs: ClubsService,
    private readonly clubShop: ClubShopService,
  ) {}

  @Get("clubs/:clubId/servers")
  public async list(@Param("clubId") clubId: string, @Req() request: Request) {
    return this.clubs.listClubServers(clubId, request.user as User | undefined);
  }

  @Post("clubs/:clubId/servers/settings")
  public async saveSettings(
    @Param("clubId") clubId: string,
    @Body()
    body: {
      mode?: string;
      count?: number;
      maps?: Array<{ id?: string; name?: string }>;
    },
    @Req() request: Request,
  ) {
    const user = request.user as User | undefined;
    if (!user) throw new ForbiddenException("Authentication required");
    return this.clubs.saveClubServerSettings(clubId, user, body || {});
  }

  @Post("clubs/:clubId/servers/mode")
  public async setMode(
    @Param("clubId") clubId: string,
    @Body() body: { mode?: string },
    @Req() request: Request,
  ) {
    const user = request.user as User | undefined;
    if (!user) throw new ForbiddenException("Authentication required");
    return this.clubs.setClubServerMode(clubId, String(body?.mode || ""), user);
  }

  @Get("clubs/:clubId/shop")
  public async shopCatalog(
    @Param("clubId") clubId: string,
    @Query("manage") manage: string | undefined,
    @Req() request: Request,
  ) {
    const wantManage = manage === "1" || manage === "true";
    if (wantManage) {
      const user = request.user as User | undefined;
      if (!user) throw new ForbiddenException("Authentication required");
      return this.clubShop.getShopForStaff(clubId, user);
    }
    return this.clubShop.getShop(clubId, { manage: false });
  }

  @Post("clubs/:clubId/shop")
  public async saveShop(
    @Param("clubId") clubId: string,
    @Body() body: { products?: unknown[] },
    @Req() request: Request,
  ) {
    const user = request.user as User | undefined;
    if (!user) throw new ForbiddenException("Authentication required");
    return this.clubShop.saveShop(clubId, user, (body || {}) as any);
  }

  @Post("clubs/:clubId/shop/checkout")
  public async checkout(
    @Param("clubId") clubId: string,
    @Body()
    body: {
      product_id?: string;
      duration?: string;
      payWith?: "bale" | "ypoint";
      server_id?: string | null;
      termsAccepted?: boolean;
    },
    @Req() request: Request,
  ) {
    const user = request.user as User | undefined;
    if (!user) throw new ForbiddenException("Authentication required");
    return this.clubShop.checkout(clubId, user, body || {});
  }

  @Get("clubs/:clubId/shop/orders")
  public async shopOrders(
    @Param("clubId") clubId: string,
    @Req() request: Request,
  ) {
    const user = request.user as User | undefined;
    if (!user) throw new ForbiddenException("Authentication required");
    return this.clubShop.listOrders(clubId, user);
  }

  @Patch("clubs/:clubId/shop/orders/:orderId")
  public async markShopOrderDone(
    @Param("clubId") clubId: string,
    @Param("orderId") orderId: string,
    @Body() body: { fulfillment_status?: string },
    @Req() request: Request,
  ) {
    const user = request.user as User | undefined;
    if (!user) throw new ForbiddenException("Authentication required");
    if (body?.fulfillment_status && body.fulfillment_status !== "done") {
      return { success: false };
    }
    return this.clubShop.markOrderFulfilled(clubId, user, orderId);
  }
}
