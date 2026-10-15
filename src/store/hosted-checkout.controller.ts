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
import { HostedServersService } from "../hosted-servers/hosted-servers.service";
import { StoreService } from "./store.service";

// Lives under /hosted-servers because the API ingress does not route /store.
@Controller("hosted-servers")
export class HostedCheckoutController {
  constructor(
    private readonly store: StoreService,
    private readonly hostedServers: HostedServersService,
  ) {}

  /**
   * Duplicate of HostedServersController quote — registered here so older
   * rollouts that only wired the store checkout controller still price Host.
   */
  @Get("section-host/quote")
  public async sectionHostQuote(
    @Query("duration") duration?: string,
    @Query("slots") slots?: string,
    @Query("sectionMode") sectionMode?: string,
  ) {
    return this.hostedServers.quoteSectionHost(String(duration || "1h"), {
      slots: slots !== undefined && slots !== "" ? Number(slots) : undefined,
      sectionMode: sectionMode || undefined,
    });
  }

  /**
   * Host pricing write on the checkout controller so store-only rollouts still
   * persist admin rates. Path is unique (not shared with HostedServersController).
   */
  @Post("host-pricing")
  public async sectionHostPricing(
    @Req() request: Request,
    @Body()
    body: {
      section_host_price_irr_per_hour?: number;
      section_host_price_ypoint_per_hour?: number;
      section_host_slot_price_irr_per_hour?: number;
      section_host_slot_price_ypoint_per_hour?: number;
    },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    if (user.role !== "administrator") {
      throw new ForbiddenException("Administrator access required");
    }
    return this.hostedServers.updateSectionHostPricing({
      section_host_price_irr_per_hour: body?.section_host_price_irr_per_hour,
      section_host_price_ypoint_per_hour:
        body?.section_host_price_ypoint_per_hour,
      section_host_slot_price_irr_per_hour:
        body?.section_host_slot_price_irr_per_hour,
      section_host_slot_price_ypoint_per_hour:
        body?.section_host_slot_price_ypoint_per_hour,
    });
  }

  /**
   * Flat aliases first — some ingress / older images 404 nested
   * `section-host/checkout` even when this controller is live.
   */
  @Post(["host-checkout", "section-host-checkout", "section-host/checkout"])
  public async sectionHostCheckout(
    @Req() request: Request,
    @Body()
    body: {
      sectionMode?: string;
      duration?: string;
      label?: string;
      slots?: number;
      connectPassword?: string;
      adminSteamId?: string;
      termsAccepted?: boolean;
      payWith?: "bale" | "ypoint";
    },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    return this.store.checkoutSectionHost(user.steam_id, {
      termsAccepted: Boolean(body?.termsAccepted),
      sectionMode: body?.sectionMode,
      duration: body?.duration,
      label: body?.label,
      slots: body?.slots,
      connectPassword: body?.connectPassword,
      adminSteamId: body?.adminSteamId,
      payWith: body.payWith === "ypoint" ? "ypoint" : "bale",
    });
  }

  @Post("checkout")
  public async checkout(
    @Req() request: Request,
    @Body()
    body: {
      productId?: string;
      hostedServerId?: string;
      type?: string;
      label?: string;
      sectionMode?: string;
      duration?: string;
      slots?: number;
      connectPassword?: string;
      adminSteamId?: string;
      termsAccepted?: boolean;
      payWith?: "bale" | "ypoint";
    },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    // Servers → Host configure-and-pay uses this existing path (always routed).
    if (!body?.productId && body?.sectionMode && body?.duration) {
      return this.store.checkoutSectionHost(user.steam_id, {
        termsAccepted: Boolean(body?.termsAccepted),
        sectionMode: body.sectionMode,
        duration: body.duration,
        label: body.label,
        slots: body.slots,
        connectPassword: body.connectPassword,
        adminSteamId: body.adminSteamId,
        payWith: body.payWith === "ypoint" ? "ypoint" : "bale",
      });
    }
    if (!body?.productId) {
      throw new BadRequestException("productId required");
    }
    return this.store.checkoutHosted(body.productId, user.steam_id, {
      termsAccepted: Boolean(body?.termsAccepted),
      hostedServerId: body.hostedServerId || undefined,
      type: body.type,
      label: body.label,
      sectionMode: body.sectionMode,
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

  @Post("vip-checkout")
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

  /** @deprecated keep old path for in-flight clients */
  @Post("vip-shop/checkout")
  public async vipShopCheckoutLegacy(
    @Req() request: Request,
    @Body()
    body: {
      server_id?: string;
      duration?: string;
      termsAccepted?: boolean;
    },
  ) {
    return this.vipShopCheckout(request, body);
  }
}
