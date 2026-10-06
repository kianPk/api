import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes, randomUUID } from "crypto";
import { Readable } from "stream";
import { PostgresService } from "../postgres/postgres.service";
import { BaleConfig } from "../configs/types/BaleConfig";
import { AppConfig } from "../configs/types/AppConfig";
import { SteamConfig } from "../configs/types/SteamConfig";
import { resolveSteamId64 } from "../utilities/resolveSteamId64";
import { S3Service } from "../s3/s3.service";

import { YpointService } from "../ypoint/ypoint.service";
import { IrrService } from "../irr/irr.service";
import { RconService } from "../rcon/rcon.service";
import { NotificationsService } from "../notifications/notifications.service";
import { e_notification_types_enum } from "../../generated/schema";
import { ChallengesService } from "../challenges/challenges.service";
import type { ChallengeTier } from "../challenges/challenge-catalog";
import { HostedServersService } from "../hosted-servers/hosted-servers.service";

const IMAGE_PREFIX = "store";
const VIP_DURATION =
  /^(perm|permanent|0|lifetime|forever|\d+\s*(m|min|mins|h|hr|hrs|d|day|days|w|week|weeks|mo|month|months))$/i;
const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

type StoreProductRow = {
  id: string;
  title: string;
  slug: string;
  description: string;
  price_irr: number;
  image_url: string | null;
  active: boolean;
  ypoint_amount: number | null;
  vip_server_id: string | null;
  vip_duration: string | null;
  subscription_tier: string | null;
};

/** Snapshot of one cart line stored on store_orders.cart_items */
type CartItemSnapshot = {
  product_id: string;
  title: string;
  price_irr: number;
  ypoint_amount: number | null;
  vip_server_id: string | null;
  vip_duration: string | null;
  subscription_tier: string | null;
};

type StoreOrderRow = {
  id: string;
  product_id: string;
  buyer_steam_id: string;
  amount_irr: number;
  status: string;
  bale_payload: string;
};

@Injectable()
export class StoreService {
  private readonly envBale: BaleConfig;
  private readonly app: AppConfig;

  constructor(
    private readonly postgres: PostgresService,
    private readonly configService: ConfigService,
    private readonly logger: Logger,
    private readonly ypoint: YpointService,
    private readonly irr: IrrService,
    private readonly rcon: RconService,
    private readonly notifications: NotificationsService,
    private readonly s3: S3Service,
    private readonly challenges: ChallengesService,
    private readonly hostedServers: HostedServersService,
  ) {
    this.envBale = this.configService.get<BaleConfig>("bale");
    this.app = this.configService.get<AppConfig>("app");
  }

  public async uploadProductImage(
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    const ext = EXTENSION_BY_MIMETYPE[mimetype];
    if (!ext) {
      throw new BadRequestException("Unsupported image type");
    }
    const filename = `${randomBytes(12).toString("hex")}.${ext}`;
    const key = `${IMAGE_PREFIX}/${filename}`;
    await this.s3.put(key, buffer, mimetype);
    this.logger.log(`Uploaded store product image ${filename}`);
    return filename;
  }

  public async getProductImageStream(
    filename: string,
  ): Promise<{ stream: Readable; contentType: string; etag?: string } | null> {
    if (!/^[0-9a-f]{24}\.(png|jpg|webp|gif)$/.test(filename)) {
      return null;
    }
    const key = `${IMAGE_PREFIX}/${filename}`;
    if (!(await this.s3.has(key))) {
      return null;
    }
    const [stream, stat] = await Promise.all([
      this.s3.get(key),
      this.s3.stat(key),
    ]);
    const byExt: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
    };
    const ext = filename.split(".").pop() || "png";
    return {
      stream,
      contentType: stat.metaData?.["content-type"] || byExt[ext] || "image/png",
      etag: stat.etag,
    };
  }

  /** Env wins; settings (`bale.*`) fill gaps so tokens can be set without kubectl. */
  private async resolveBale(): Promise<BaleConfig> {
    const rows = await this.postgres.query<
      Array<{ name: string; value: string }>
    >(
      `SELECT name, value FROM settings
       WHERE name = ANY($1::text[])`,
      [
        [
          "bale.bot_token",
          "bale.provider_token",
          "bale.bot_username",
          "bale.webhook_secret",
        ],
      ],
    );
    const map = Object.fromEntries(rows.map((r) => [r.name, r.value ?? ""]));
    return {
      botToken: this.envBale.botToken || map["bale.bot_token"] || "",
      providerToken:
        this.envBale.providerToken || map["bale.provider_token"] || "",
      botUsername: this.envBale.botUsername || map["bale.bot_username"] || "",
      webhookSecret:
        this.envBale.webhookSecret || map["bale.webhook_secret"] || "",
    };
  }

  public async isConfigured(): Promise<boolean> {
    const bale = await this.resolveBale();
    return Boolean(bale.botToken && bale.providerToken);
  }

  public async getPublicStatus() {
    const bale = await this.resolveBale();
    return {
      configured: Boolean(bale.botToken && bale.providerToken),
      botUsername: bale.botUsername || null,
      webhookHint: `https://${this.app.apiDomain}/store/bale-webhook`,
    };
  }

  public async getWebhookSecret(): Promise<string> {
    return (await this.resolveBale()).webhookSecret || "";
  }

  public async checkout(
    productId: string,
    buyerSteamId: string,
    opts?: { termsAccepted?: boolean },
  ) {
    return this.checkoutCart([productId], buyerSteamId, opts);
  }

  /**
   * Create one pending order for 1..N products, then return a Bale deep link.
   * Multi-item carts are stored in cart_items jsonb; amount_irr is the sum.
   */
  public async checkoutCart(
    productIds: string[],
    buyerSteamId: string,
    opts?: { termsAccepted?: boolean },
  ) {
    if (!opts?.termsAccepted) {
      throw new BadRequestException("Terms must be accepted before checkout");
    }

    const rawIds = (productIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    if (!rawIds.length) {
      throw new BadRequestException("productIds required");
    }
    if (rawIds.length > 20) {
      throw new BadRequestException("Too many products in cart");
    }

    const bale = await this.resolveBale();
    if (!bale.botToken || !bale.providerToken) {
      throw new ServiceUnavailableException(
        "Bale Pay is not configured. Set BALE_BOT_TOKEN and BALE_PROVIDER_TOKEN.",
      );
    }

    await this.ensureCartSchema();

    const uniqueIds = [...new Set(rawIds)];
    let products: StoreProductRow[];
    try {
      products = await this.postgres.query<StoreProductRow[]>(
        `SELECT id, title, slug, description, price_irr, image_url, active,
                ypoint_amount, vip_server_id, vip_duration, subscription_tier
         FROM store_products
         WHERE id = ANY($1::uuid[])
           AND active = true`,
        [uniqueIds],
      );
    } catch (error) {
      // Older DBs may lack subscription_tier — still allow checkout.
      const msg = error instanceof Error ? error.message : String(error);
      if (!/subscription_tier/i.test(msg)) throw error;
      const legacy = await this.postgres.query<
        Array<Omit<StoreProductRow, "subscription_tier">>
      >(
        `SELECT id, title, slug, description, price_irr, image_url, active,
                ypoint_amount, vip_server_id, vip_duration
         FROM store_products
         WHERE id = ANY($1::uuid[])
           AND active = true`,
        [uniqueIds],
      );
      products = legacy.map((p) => ({
        ...p,
        subscription_tier: null as string | null,
      }));
    }
    if (products.length !== uniqueIds.length) {
      throw new NotFoundException("One or more products are unavailable");
    }

    const byId = new Map(products.map((p) => [p.id, p]));
    const ordered = rawIds.map((id) => {
      const p = byId.get(id);
      if (!p) throw new NotFoundException("Product not found");
      return p;
    });
    for (const p of ordered) {
      if (p.price_irr < 0) {
        throw new BadRequestException("Invalid product price");
      }
    }

    const cartItems: CartItemSnapshot[] = ordered.map((p) => ({
      product_id: p.id,
      title: p.title,
      price_irr: Number(p.price_irr),
      ypoint_amount: p.ypoint_amount,
      vip_server_id: p.vip_server_id,
      vip_duration: p.vip_duration,
      subscription_tier: p.subscription_tier ?? null,
    }));
    const amountIrr = cartItems.reduce((sum, i) => sum + i.price_irr, 0);
    const primary = ordered[0];
    const orderId = randomUUID();
    const payload = `store:${orderId}`;

    await this.cancelPendingOrders(buyerSteamId);

    try {
      await this.postgres.query(
        `INSERT INTO store_orders
          (id, product_id, buyer_steam_id, amount_irr, status, bale_payload,
           cart_items, terms_accepted_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6::jsonb, now())`,
        [
          orderId,
          primary.id,
          buyerSteamId,
          amountIrr,
          payload,
          JSON.stringify(cartItems),
        ],
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Store checkout insert failed: ${msg}`);
      throw new BadRequestException(`Checkout failed: ${msg.slice(0, 180)}`);
    }

    const deepLink = this.buildDeepLink(orderId, bale.botUsername);
    const productTitle =
      cartItems.length === 1
        ? primary.title
        : `${primary.title} +${cartItems.length - 1}`;

    return {
      orderId,
      amountIrr,
      productTitle,
      itemCount: cartItems.length,
      deepLink,
      botUsername: bale.botUsername || null,
      startParam: `pay_${orderId.replace(/-/g, "")}`,
    };
  }

  /**
   * Checkout for a hosted server plan. A new purchase is capacity-checked
   * here so buyers are not charged for a server the node can't run; renewals
   * target one of the buyer's existing hosted servers.
   */
  public async checkoutHosted(
    productId: string,
    buyerSteamId: string,
    opts: {
      termsAccepted?: boolean;
      hostedServerId?: string;
      type?: string;
      label?: string;
      payWith?: "bale" | "ypoint";
    },
  ) {
    if (!opts?.termsAccepted) {
      throw new BadRequestException("Terms must be accepted before checkout");
    }
    const payWithYpoint = opts.payWith === "ypoint";

    const bale = payWithYpoint ? null : await this.resolveBale();
    if (bale && (!bale.botToken || !bale.providerToken)) {
      throw new ServiceUnavailableException(
        "Bale Pay is not configured. Set BALE_BOT_TOKEN and BALE_PROVIDER_TOKEN.",
      );
    }

    await this.ensureCartSchema();

    const [product] = await this.postgres.query<
      Array<{
        id: string;
        title: string;
        price_irr: number;
        price_ypoint: number | null;
        hosted_slots: number | null;
        vip_duration: string | null;
      }>
    >(
      `SELECT id, title, price_irr, price_ypoint, hosted_slots, vip_duration
       FROM store_products
       WHERE id = $1 AND active = true AND hosted_slots IS NOT NULL`,
      [String(productId || "").trim()],
    );
    if (!product) {
      throw new NotFoundException("Plan not found");
    }
    let priceYpoint = Number(product.price_ypoint || 0);
    if (payWithYpoint && priceYpoint <= 0) {
      throw new BadRequestException("This plan cannot be bought with Ypoints");
    }

    let kind: "new" | "renew" = "new";
    let hostedServerId: string | null = null;
    let type: string | null = null;
    let label: string | null = null;
    let extraSlots = 0;
    let extraSlotsIrr = 0;

    if (opts.hostedServerId) {
      const hosted = await this.hostedServers.assertCanRenew(
        opts.hostedServerId,
        buyerSteamId,
      );
      if (hosted.slots - hosted.extra_slots !== product.hosted_slots) {
        throw new BadRequestException(
          "Renew with a plan that has the same number of slots",
        );
      }
      const extras = await this.hostedServers.extraSlotsRenewalCost(
        hosted,
        HostedServersService.durationMs(product.vip_duration || "30d"),
      );
      if (payWithYpoint && hosted.extra_slots > 0 && !extras.price_ypoint) {
        throw new BadRequestException(
          "The extra slots on this server cannot be paid with Ypoints",
        );
      }
      extraSlots = hosted.extra_slots;
      extraSlotsIrr = extras.price_irr;
      priceYpoint += extras.price_ypoint;
      kind = "renew";
      hostedServerId = hosted.id;
    } else {
      await this.hostedServers.assertCanSellNew();
      type = opts.type || "Casual";
      if (!HostedServersService.isHostedType(type)) {
        throw new BadRequestException("Unsupported server mode");
      }
      label = (opts.label || "")
        .replace(/[\r\n"';\\]/g, " ")
        .trim()
        .slice(0, 64);
    }

    const cartItems: CartItemSnapshot[] = [
      {
        product_id: product.id,
        title: product.title,
        price_irr: Number(product.price_irr),
        ypoint_amount: null,
        vip_server_id: null,
        vip_duration: null,
        subscription_tier: null,
      },
    ];
    if (extraSlotsIrr > 0) {
      cartItems.push({
        product_id: product.id,
        title: `+${extraSlots} extra slots`,
        price_irr: extraSlotsIrr,
        ypoint_amount: null,
        vip_server_id: null,
        vip_duration: null,
        subscription_tier: null,
      });
    }
    const amountIrr = Number(product.price_irr) + extraSlotsIrr;
    const orderId = randomUUID();
    const payload = payWithYpoint ? `ypoint:${orderId}` : `store:${orderId}`;

    if (!payWithYpoint) {
      await this.cancelPendingOrders(buyerSteamId);
    }

    await this.postgres.query(
      `INSERT INTO store_orders
        (id, product_id, buyer_steam_id, amount_irr, status, bale_payload,
         cart_items, terms_accepted_at, hosted_kind, hosted_server_id,
         hosted_type, hosted_label, payment_method, amount_ypoint)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6::jsonb, now(), $7, $8, $9, $10,
               $11, $12)`,
      [
        orderId,
        product.id,
        buyerSteamId,
        payWithYpoint ? 0 : amountIrr,
        payload,
        JSON.stringify(cartItems),
        kind,
        hostedServerId,
        type,
        label,
        payWithYpoint ? "ypoint" : "bale",
        payWithYpoint ? priceYpoint : null,
      ],
    );

    if (payWithYpoint) {
      const balance = await this.completeYpointOrder(
        orderId,
        buyerSteamId,
        priceYpoint,
      );
      const [fulfilled] = await this.postgres.query<
        Array<{ hosted_server_id: string | null }>
      >(`SELECT hosted_server_id FROM store_orders WHERE id = $1`, [orderId]);
      return {
        orderId,
        paid: true,
        amountYpoint: priceYpoint,
        balance,
        productTitle: product.title,
        hostedServerId: fulfilled?.hosted_server_id || hostedServerId,
      };
    }

    return {
      orderId,
      paid: false,
      amountIrr,
      productTitle: product.title,
      deepLink: this.buildDeepLink(orderId, bale!.botUsername),
      botUsername: bale!.botUsername || null,
    };
  }

  /** Buy extra slots for a rented server, priced for the days it has left. */
  public async checkoutHostedSlots(
    hostedServerId: string,
    buyerSteamId: string,
    opts: { count: number; termsAccepted?: boolean; payWith?: string },
  ) {
    if (!opts?.termsAccepted) {
      throw new BadRequestException("Terms must be accepted before checkout");
    }
    const payWithYpoint = opts.payWith === "ypoint";
    const bale = payWithYpoint ? null : await this.resolveBale();
    if (bale && (!bale.botToken || !bale.providerToken)) {
      throw new ServiceUnavailableException(
        "Bale Pay is not configured. Set BALE_BOT_TOKEN and BALE_PROVIDER_TOKEN.",
      );
    }
    await this.ensureCartSchema();

    const hosted = await this.hostedServers.getHosted(hostedServerId);
    if (!hosted || String(hosted.owner_steam_id) !== String(buyerSteamId)) {
      throw new NotFoundException("Server not found");
    }
    const quote = await this.hostedServers.quoteExtraSlots(hosted, opts.count);
    if (payWithYpoint && quote.price_ypoint <= 0) {
      throw new BadRequestException(
        "Extra slots cannot be bought with Ypoints",
      );
    }

    // The payment paths read the order through its product, so the order
    // borrows the server's plan (or any plan, if that one was deleted).
    const [plan] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id FROM store_products
       WHERE hosted_slots IS NOT NULL
       ORDER BY (id = $1::uuid) DESC, active DESC, sort_order ASC
       LIMIT 1`,
      [hosted.product_id],
    );
    if (!plan) {
      throw new BadRequestException("No server plan exists to bill against");
    }

    const title = `+${quote.count} extra slots`;
    const cartItems: CartItemSnapshot[] = [
      {
        product_id: plan.id,
        title,
        price_irr: quote.price_irr,
        ypoint_amount: null,
        vip_server_id: null,
        vip_duration: null,
        subscription_tier: null,
      },
    ];
    const orderId = randomUUID();
    const payload = payWithYpoint ? `ypoint:${orderId}` : `store:${orderId}`;

    if (!payWithYpoint) {
      await this.cancelPendingOrders(buyerSteamId);
    }

    await this.postgres.query(
      `INSERT INTO store_orders
        (id, product_id, product_title, buyer_steam_id, amount_irr, status,
         bale_payload, cart_items, terms_accepted_at, hosted_kind,
         hosted_server_id, hosted_extra_slots, payment_method, amount_ypoint)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7::jsonb, now(), 'slots',
               $8, $9, $10, $11)`,
      [
        orderId,
        plan.id,
        title,
        buyerSteamId,
        payWithYpoint ? 0 : quote.price_irr,
        payload,
        JSON.stringify(cartItems),
        hosted.id,
        quote.count,
        payWithYpoint ? "ypoint" : "bale",
        payWithYpoint ? quote.price_ypoint : null,
      ],
    );

    if (payWithYpoint) {
      const balance = await this.completeYpointOrder(
        orderId,
        buyerSteamId,
        quote.price_ypoint,
      );
      return {
        orderId,
        paid: true,
        amountYpoint: quote.price_ypoint,
        balance,
        productTitle: title,
        hostedServerId: hosted.id,
      };
    }

    return {
      orderId,
      paid: false,
      amountIrr: quote.price_irr,
      productTitle: title,
      deepLink: this.buildDeepLink(orderId, bale!.botUsername),
      botUsername: bale!.botUsername || null,
    };
  }

  /**
   * Player buys VIP for a hosted public server via Bale Pay (Toman/IRR).
   * On payment: VIP is granted and the server owner is credited in their
   * site IRR (Toman) wallet.
   */
  public async checkoutHostedVipShop(
    serverId: string,
    buyerSteamId: string,
    opts: { duration?: string; termsAccepted?: boolean },
  ) {
    if (!opts?.termsAccepted) {
      throw new BadRequestException("Terms must be accepted before checkout");
    }
    StoreService.requireUuid(serverId);
    const duration = String(opts.duration || "")
      .trim()
      .toLowerCase() as "7d" | "30d" | "90d";
    if (!["7d", "30d", "90d"].includes(duration)) {
      throw new BadRequestException("Duration must be 7d, 30d, or 90d");
    }

    const bale = await this.resolveBale();
    if (!bale.botToken || !bale.providerToken) {
      throw new ServiceUnavailableException(
        "Bale Pay is not configured. Set BALE_BOT_TOKEN and BALE_PROVIDER_TOKEN.",
      );
    }
    await this.ensureCartSchema();

    const [hosted] = await this.postgres.query<
      Array<{
        id: string;
        server_id: string;
        owner_steam_id: string;
        label: string;
        vip_sale_enabled: boolean;
        vip_price_7d: number;
        vip_price_30d: number;
        vip_price_90d: number;
      }>
    >(
      `SELECT h.id, h.server_id::text AS server_id, h.owner_steam_id::text,
              COALESCE(s.label, h.label) AS label,
              COALESCE(h.vip_sale_enabled, false) AS vip_sale_enabled,
              COALESCE(h.vip_price_7d, 0) AS vip_price_7d,
              COALESCE(h.vip_price_30d, 0) AS vip_price_30d,
              COALESCE(h.vip_price_90d, 0) AS vip_price_90d
       FROM hosted_servers h
       LEFT JOIN servers s ON s.id = h.server_id
       WHERE (h.server_id = $1::uuid OR h.pending_server_id = $1::uuid)
         AND h.status = 'active'
         AND h.server_id IS NOT NULL
       ORDER BY h.created_at DESC
       LIMIT 1`,
      [serverId],
    );
    if (!hosted?.vip_sale_enabled) {
      throw new NotFoundException("VIP is not for sale on this server");
    }
    if (String(hosted.owner_steam_id) === String(buyerSteamId)) {
      throw new BadRequestException("You cannot buy VIP on your own server");
    }

    const priceIrr =
      duration === "7d"
        ? Number(hosted.vip_price_7d)
        : duration === "30d"
          ? Number(hosted.vip_price_30d)
          : Number(hosted.vip_price_90d);
    if (!Number.isFinite(priceIrr) || priceIrr <= 0) {
      throw new BadRequestException("That VIP package is not available");
    }

    // Orders need a product_id FK; borrow any store product as the bill carrier.
    const [carrier] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id FROM store_products
       ORDER BY active DESC, sort_order ASC
       LIMIT 1`,
    );
    if (!carrier) {
      throw new BadRequestException("No store product exists to bill against");
    }

    const title = `VIP ${duration} · ${hosted.label || "server"}`.slice(0, 120);
    const cartItems: CartItemSnapshot[] = [
      {
        product_id: carrier.id,
        title,
        price_irr: priceIrr,
        ypoint_amount: null,
        vip_server_id: hosted.server_id,
        vip_duration: duration,
        subscription_tier: null,
      },
    ];
    const orderId = randomUUID();
    const payload = `store:${orderId}`;

    await this.cancelPendingOrders(buyerSteamId);

    await this.postgres.query(
      `INSERT INTO store_orders
        (id, product_id, product_title, buyer_steam_id, amount_irr, status,
         bale_payload, cart_items, terms_accepted_at, hosted_kind,
         hosted_server_id, payment_method)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7::jsonb, now(), 'vip_shop',
               $8, 'bale')`,
      [
        orderId,
        carrier.id,
        title,
        buyerSteamId,
        priceIrr,
        payload,
        JSON.stringify(cartItems),
        hosted.id,
      ],
    );

    return {
      orderId,
      paid: false as const,
      amountIrr: priceIrr,
      productTitle: title,
      deepLink: this.buildDeepLink(orderId, bale.botUsername),
      botUsername: bale.botUsername || null,
      duration,
      serverId: hosted.server_id,
      label: hosted.label,
    };
  }

  /** After Bale pay: credit the hosted server owner’s IRR wallet for VIP sales. */
  private async creditHostedVipOwner(order: {
    id: string;
    amount_irr?: number | null;
    hosted_kind?: string | null;
    hosted_server_id?: string | null;
  }) {
    if (order.hosted_kind !== "vip_shop" || !order.hosted_server_id) return;
    const amountIrr = Math.floor(Number(order.amount_irr || 0));
    if (amountIrr <= 0) return;

    const [hosted] = await this.postgres.query<
      Array<{ owner_steam_id: string; label: string }>
    >(
      `SELECT h.owner_steam_id::text, COALESCE(s.label, h.label) AS label
       FROM hosted_servers h
       LEFT JOIN servers s ON s.id = h.server_id
       WHERE h.id = $1::uuid
       LIMIT 1`,
      [order.hosted_server_id],
    );
    if (!hosted?.owner_steam_id) {
      this.logger.error(
        `VIP shop owner credit skipped: hosted missing order=${order.id}`,
      );
      return;
    }

    await this.irr.credit({
      steamId: hosted.owner_steam_id,
      amountIrr,
      reason: "hosted_vip_earning",
      refType: "hosted_vip_earning",
      refId: order.id,
    });

    try {
      const toman = Math.round(amountIrr / 10);
      await this.notifications.notifyPlayers(
        "StorePurchasePaid" as e_notification_types_enum,
        {
          title: "VIP sale",
          message: `Someone bought VIP on <b>${NotificationsService.escapeHtml(
            hosted.label || "your server",
          )}</b>. +${toman.toLocaleString("en-US")} تومان credited to your wallet.`,
          role: "user",
          entity_id: `${order.id}:owner`,
          steamIds: [hosted.owner_steam_id],
        },
      );
    } catch (error) {
      this.logger.warn(
        `VIP owner notify failed order=${order.id}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Buy 1..N regular store products with Ypoints: the balance is debited and
   * the order is fulfilled right away, no Bale invoice involved.
   */
  public async checkoutCartWithYpoints(
    productIds: string[],
    buyerSteamId: string,
    opts?: { termsAccepted?: boolean },
  ) {
    if (!opts?.termsAccepted) {
      throw new BadRequestException("Terms must be accepted before checkout");
    }
    const rawIds = (productIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    if (!rawIds.length) {
      throw new BadRequestException("productIds required");
    }
    if (rawIds.length > 20) {
      throw new BadRequestException("Too many products in cart");
    }

    await this.ensureCartSchema();

    const products = await this.postgres.query<
      Array<StoreProductRow & { price_ypoint: number | null }>
    >(
      `SELECT id, title, slug, description, price_irr, image_url, active,
              ypoint_amount, vip_server_id, vip_duration, subscription_tier,
              price_ypoint
       FROM store_products
       WHERE id = ANY($1::uuid[])
         AND active = true
         AND hosted_slots IS NULL`,
      [[...new Set(rawIds)]],
    );
    const byId = new Map(products.map((p) => [p.id, p]));
    const ordered = rawIds.map((id) => {
      const product = byId.get(id);
      if (!product) {
        throw new NotFoundException("One or more products are unavailable");
      }
      if (!(Number(product.price_ypoint) > 0)) {
        throw new BadRequestException(
          `${product.title} cannot be bought with Ypoints`,
        );
      }
      if (Number(product.ypoint_amount) > 0) {
        throw new BadRequestException(
          "Ypoint packs cannot be bought with Ypoints",
        );
      }
      return product;
    });

    const cartItems = ordered.map<CartItemSnapshot>((p) => ({
      product_id: p.id,
      title: p.title,
      price_irr: Number(p.price_irr),
      ypoint_amount: null,
      vip_server_id: p.vip_server_id,
      vip_duration: p.vip_duration,
      subscription_tier: p.subscription_tier ?? null,
    }));
    const amountYpoint = ordered.reduce(
      (sum, p) => sum + Number(p.price_ypoint),
      0,
    );
    const primary = ordered[0];
    const orderId = randomUUID();

    await this.postgres.query(
      `INSERT INTO store_orders
        (id, product_id, buyer_steam_id, amount_irr, status, bale_payload,
         cart_items, terms_accepted_at, payment_method, amount_ypoint)
       VALUES ($1, $2, $3, 0, 'pending', $4, $5::jsonb, now(), 'ypoint', $6)`,
      [
        orderId,
        primary.id,
        buyerSteamId,
        `ypoint:${orderId}`,
        JSON.stringify(cartItems),
        amountYpoint,
      ],
    );

    const balance = await this.completeYpointOrder(
      orderId,
      buyerSteamId,
      amountYpoint,
    );
    return {
      orderId,
      paid: true,
      amountYpoint,
      balance,
      itemCount: cartItems.length,
    };
  }

  private async completeYpointOrder(
    orderId: string,
    buyerSteamId: string,
    amount: number,
  ): Promise<number> {
    try {
      await this.ypoint.debitMany({
        steamIds: [buyerSteamId],
        amount,
        reason: "store_purchase",
        refType: "store_order",
        refId: orderId,
      });
    } catch (error) {
      await this.postgres.query(
        `UPDATE store_orders SET status = 'failed' WHERE id = $1 AND status = 'pending'`,
        [orderId],
      );
      throw error;
    }

    const [order] = await this.postgres.query<
      Array<{
        id: string;
        buyer_steam_id: string;
        vip_server_id: string | null;
        vip_duration: string | null;
        vip_granted_at: string | null;
        product_title: string;
        ypoint_amount: number | null;
        subscription_tier: string | null;
        cart_items: CartItemSnapshot[] | null;
      }>
    >(
      `UPDATE store_orders o
       SET status = 'paid', paid_at = COALESCE(o.paid_at, now())
       FROM store_products p
       WHERE o.id = $1 AND p.id = o.product_id
       RETURNING o.id, o.buyer_steam_id::text, p.vip_server_id, p.vip_duration,
                 o.vip_granted_at, COALESCE(o.product_title, p.title) AS product_title,
                 NULL::int AS ypoint_amount, p.subscription_tier, o.cart_items`,
      [orderId],
    );
    if (order) {
      await this.fulfillOrderBenefits(order);
      await this.notifyPurchasePaid(order);
    }
    this.logger.log(
      `Store order paid with Ypoints order=${orderId} amount=${amount}`,
    );
    return this.ypoint.getBalance(buyerSteamId);
  }

  /** Idempotent: add cart columns if a previous deploy skipped the SQL script. */
  private async ensureCartSchema() {
    try {
      await this.postgres.query(`
        ALTER TABLE public.store_orders
          ADD COLUMN IF NOT EXISTS cart_items jsonb,
          ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz
      `);
    } catch (error) {
      this.logger.warn(
        `ensureCartSchema: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  public async handleStartPay(chatId: number | string, orderKey: string) {
    const orderId = this.expandOrderId(orderKey);
    if (!orderId) {
      throw new BadRequestException("Invalid order");
    }

    const rows = await this.postgres.query<
      Array<{
        id: string;
        status: string;
        amount_irr: number;
        bale_payload: string;
        cart_items: CartItemSnapshot[] | null;
        title: string;
        description: string;
        price_irr: number;
        active: boolean;
      }>
    >(
      `SELECT o.id, o.status, o.amount_irr, o.bale_payload, o.cart_items,
              p.title, p.description, p.price_irr, p.active
       FROM store_orders o
       JOIN store_products p ON p.id = o.product_id
       WHERE o.id = $1
       LIMIT 1`,
      [orderId],
    );

    const order = rows.at(0);
    if (!order) {
      throw new NotFoundException("Order not found");
    }
    if (order.status !== "pending") {
      throw new BadRequestException(`Order is ${order.status}`);
    }

    const cart = this.normalizeCartItems(order.cart_items);
    let lines: Array<{ label: string; amount: number }>;
    let amountIrr: number;
    let title: string;
    let description: string;

    if (cart.length > 0) {
      // Frozen cart snapshot from checkout — don't rewrite prices here.
      lines = cart.map((i) => ({
        label: i.title.slice(0, 32),
        amount: Number(i.price_irr),
      }));
      amountIrr = lines.reduce((s, l) => s + l.amount, 0);
      if (amountIrr !== Number(order.amount_irr)) {
        await this.postgres.query(
          `UPDATE store_orders SET amount_irr = $2 WHERE id = $1 AND status = 'pending'`,
          [order.id, amountIrr],
        );
      }
      title =
        cart.length === 1
          ? cart[0].title
          : `YGuard Store (${cart.length} items)`;
      const toman = Math.round(amountIrr / 10);
      description = `${cart
        .map((i) => i.title)
        .join(" · ")
        .slice(0, 180)} · ${toman.toLocaleString("en-US")} تومان`.slice(0, 255);
    } else {
      // Legacy single-product orders: sync live price.
      if (!order.active) {
        throw new BadRequestException("Product unavailable");
      }
      amountIrr = Number(order.price_irr);
      if (amountIrr !== Number(order.amount_irr)) {
        await this.postgres.query(
          `UPDATE store_orders SET amount_irr = $2 WHERE id = $1 AND status = 'pending'`,
          [order.id, amountIrr],
        );
      }
      title = order.title;
      const toman = Math.round(amountIrr / 10);
      const baseDescription = (order.description || order.title).slice(0, 200);
      description =
        `${baseDescription} · ${toman.toLocaleString("en-US")} تومان`.slice(
          0,
          255,
        );
      lines = [{ label: order.title.slice(0, 32), amount: amountIrr }];
    }

    await this.sendInvoice({
      chatId,
      title,
      description,
      payload: order.bale_payload,
      prices: lines,
      providerToken: (await this.resolveBale()).providerToken,
    });

    return { ok: true };
  }

  private normalizeCartItems(raw: unknown): CartItemSnapshot[] {
    if (!raw) return [];
    const list = Array.isArray(raw)
      ? raw
      : typeof raw === "string"
        ? (JSON.parse(raw) as unknown)
        : raw;
    if (!Array.isArray(list)) return [];
    return list
      .map((row) => {
        const r = row as Partial<CartItemSnapshot>;
        return {
          product_id: String(r.product_id || ""),
          title: String(r.title || "Item"),
          price_irr: Number(r.price_irr || 0),
          ypoint_amount:
            r.ypoint_amount == null ? null : Number(r.ypoint_amount),
          vip_server_id: r.vip_server_id ? String(r.vip_server_id) : null,
          vip_duration: r.vip_duration ? String(r.vip_duration) : null,
          subscription_tier: r.subscription_tier
            ? String(r.subscription_tier)
            : null,
        };
      })
      .filter((i) => i.product_id && i.price_irr >= 0);
  }

  public async handleWebhookUpdate(update: any) {
    if (update?.message?.text) {
      const text = String(update.message.text);
      const chatId = update.message.chat?.id;
      const match = text.match(/^\/start(?:@\w+)?\s+pay_([a-f0-9]{32})$/i);
      if (chatId && match) {
        await this.handleStartPay(chatId, match[1]);
        return { ok: true };
      }
    }

    if (update?.pre_checkout_query) {
      const q = update.pre_checkout_query;
      await this.answerPreCheckoutQuery(q.id, true);
      return { ok: true };
    }

    const payment =
      update?.message?.successful_payment || update?.successful_payment;
    if (payment) {
      await this.markPaid(
        String(payment.invoice_payload || ""),
        String(
          payment.telegram_payment_charge_id ||
            payment.provider_payment_charge_id ||
            "",
        ),
      );
      return { ok: true };
    }

    return { ok: true, ignored: true };
  }

  private async markPaid(payload: string, chargeId: string) {
    if (!payload.startsWith("store:")) {
      this.logger.warn(`Ignoring non-store payment payload: ${payload}`);
      return;
    }

    const updated = await this.postgres.query<
      Array<{
        id: string;
        buyer_steam_id: string;
        ypoint_amount: number | null;
        vip_server_id: string | null;
        vip_duration: string | null;
        vip_granted_at: string | null;
        product_title: string;
        subscription_tier: string | null;
        cart_items: CartItemSnapshot[] | null;
        amount_irr: number;
        hosted_kind: string | null;
        hosted_server_id: string | null;
      }>
    >(
      `UPDATE store_orders o
       SET status = 'paid',
           paid_at = COALESCE(paid_at, now()),
           bale_payment_charge_id = COALESCE(NULLIF($2, ''), bale_payment_charge_id)
       FROM store_products p
       WHERE o.bale_payload = $1
         AND o.status = 'pending'
         AND p.id = o.product_id
       RETURNING o.id, o.buyer_steam_id::text, p.ypoint_amount,
                 p.vip_server_id, p.vip_duration, o.vip_granted_at, COALESCE(o.product_title, p.title) AS product_title,
                 p.subscription_tier, o.cart_items, o.amount_irr, o.hosted_kind, o.hosted_server_id::text AS hosted_server_id`,
      [payload, chargeId || null],
    );

    const order = updated.at(0);
    if (!order) {
      const existing = await this.postgres.query<
        Array<{
          id: string;
          buyer_steam_id: string;
          vip_server_id: string | null;
          vip_duration: string | null;
          vip_granted_at: string | null;
          product_title: string;
          ypoint_amount: number | null;
          subscription_tier: string | null;
          cart_items: CartItemSnapshot[] | null;
          amount_irr: number;
          hosted_kind: string | null;
          hosted_server_id: string | null;
        }>
      >(
        `SELECT o.id, o.buyer_steam_id::text, p.vip_server_id, p.vip_duration,
                o.vip_granted_at, COALESCE(o.product_title, p.title) AS product_title, p.ypoint_amount,
                p.subscription_tier, o.cart_items, o.amount_irr, o.hosted_kind,
                o.hosted_server_id::text AS hosted_server_id
         FROM store_orders o
         JOIN store_products p ON p.id = o.product_id
         WHERE o.bale_payload = $1 AND o.status = 'paid'
         LIMIT 1`,
        [payload],
      );
      const paid = existing.at(0);
      if (paid) {
        await this.fulfillOrderBenefits(paid);
        await this.notifyPurchasePaid(paid);
      } else {
        this.logger.log(
          `Store order already paid or missing payload=${payload}`,
        );
      }
      return;
    }

    await this.fulfillOrderBenefits(order);
    await this.notifyPurchasePaid(order);

    this.logger.log(`Store order paid payload=${payload} charge=${chargeId}`);
  }

  private async fulfillOrderBenefits(order: {
    id: string;
    buyer_steam_id: string;
    ypoint_amount: number | null;
    vip_server_id: string | null;
    vip_duration: string | null;
    vip_granted_at: string | null;
    product_title: string;
    subscription_tier: string | null;
    cart_items?: CartItemSnapshot[] | null;
    amount_irr?: number | null;
    hosted_kind?: string | null;
    hosted_server_id?: string | null;
  }) {
    const cart = this.normalizeCartItems(order.cart_items);
    const lines =
      cart.length > 0
        ? cart
        : [
            {
              product_id: "",
              title: order.product_title,
              price_irr: 0,
              ypoint_amount: order.ypoint_amount,
              vip_server_id: order.vip_server_id,
              vip_duration: order.vip_duration,
              subscription_tier: order.subscription_tier,
            },
          ];

    let lineIndex = 0;
    for (const line of lines) {
      const amount = Number(line.ypoint_amount || 0);
      if (amount > 0) {
        await this.ypoint.credit({
          steamId: order.buyer_steam_id,
          amount,
          reason: "store_purchase",
          refType: "store_order",
          // Unique per line so multi-item carts credit each pack once.
          refId: lineIndex === 0 ? order.id : `${order.id}:${lineIndex}`,
        });
      }

      await this.grantVipIfNeeded({
        id: order.id,
        buyer_steam_id: order.buyer_steam_id,
        vip_server_id: line.vip_server_id,
        vip_duration: line.vip_duration,
        // Only the first VIP line uses vip_granted_at gate on the order row.
        vip_granted_at: lineIndex === 0 ? order.vip_granted_at : null,
      });

      await this.grantSubscriptionIfNeeded({
        id: order.id,
        buyer_steam_id: order.buyer_steam_id,
        subscription_tier: line.subscription_tier,
        vip_duration: line.vip_duration,
      });

      lineIndex += 1;
    }

    try {
      await this.creditHostedVipOwner(order);
    } catch (error) {
      this.logger.error(
        `Hosted VIP owner credit failed order=${order.id}`,
        error instanceof Error ? error.stack : error,
      );
    }

    try {
      await this.hostedServers.fulfillOrder(order.id);
    } catch (error) {
      this.logger.error(
        `Hosted server fulfillment failed order=${order.id}`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  public async cancelPendingOrders(steamId: string, exceptOrderId?: string) {
    const cancelled = await this.postgres.query<
      Array<{ id: string; product_title: string }>
    >(
      `UPDATE store_orders o
       SET status = 'cancelled'
       FROM store_products p
       WHERE o.product_id = p.id
         AND o.buyer_steam_id = $1::bigint
         AND o.status = 'pending'
         AND ($2::uuid IS NULL OR o.id <> $2::uuid)
       RETURNING o.id, COALESCE(o.product_title, p.title) AS product_title`,
      [steamId, exceptOrderId || null],
    );

    for (const row of cancelled) {
      await this.notifyPurchaseCancelled(row.id, steamId, row.product_title);
    }

    return { cancelled: cancelled.length };
  }

  private async notifyPurchasePaid(order: {
    id: string;
    buyer_steam_id: string;
    product_title: string;
    ypoint_amount?: number | null;
    vip_duration?: string | null;
    vip_server_id?: string | null;
    subscription_tier?: string | null;
    cart_items?: CartItemSnapshot[] | null;
  }) {
    try {
      const existing = await this.postgres.query<Array<{ id: string }>>(
        `SELECT id FROM notifications
         WHERE steam_id = $1::bigint
           AND type = 'StorePurchasePaid'
           AND entity_id = $2
         LIMIT 1`,
        [order.buyer_steam_id, order.id],
      );
      if (existing.length) return;

      const cart = this.normalizeCartItems(order.cart_items);
      const bits: string[] = [
        cart.length > 1
          ? `Payment for <b>${cart.length} store items</b> succeeded.`
          : `Payment for <b>${NotificationsService.escapeHtml(order.product_title)}</b> succeeded.`,
      ];
      const yp =
        cart.length > 0
          ? cart.reduce((s, i) => s + Number(i.ypoint_amount || 0), 0)
          : Number(order.ypoint_amount || 0);
      if (yp > 0) bits.push(`+${yp} Ypoints credited.`);
      const hasVip =
        cart.length > 0
          ? cart.some((i) => i.vip_server_id && i.vip_duration)
          : Boolean(order.vip_server_id && order.vip_duration);
      if (hasVip) {
        bits.push(`VIP activated on the server.`);
      }
      const hasSub =
        cart.length > 0
          ? cart.some(
              (i) =>
                i.subscription_tier === "premium" ||
                i.subscription_tier === "premium_plus",
            )
          : order.subscription_tier === "premium" ||
            order.subscription_tier === "premium_plus";
      if (hasSub) {
        bits.push(
          `Challenges unlocked. <a href="/challenges">Open Challenges</a>`,
        );
      }
      bits.push(`<a href="/store">Open Store</a>`);

      await this.notifications.notifyPlayers(
        "StorePurchasePaid" as e_notification_types_enum,
        {
          title: "Purchase successful",
          message: bits.join(" "),
          role: "user",
          entity_id: order.id,
          steamIds: [order.buyer_steam_id],
        },
      );
    } catch (error) {
      this.logger.warn(
        `Store paid notify failed order=${order.id}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async notifyPurchaseCancelled(
    orderId: string,
    steamId: string,
    productTitle: string,
  ) {
    try {
      const existing = await this.postgres.query<Array<{ id: string }>>(
        `SELECT id FROM notifications
         WHERE steam_id = $1::bigint
           AND type = 'StorePurchaseCancelled'
           AND entity_id = $2
         LIMIT 1`,
        [steamId, orderId],
      );
      if (existing.length) return;

      await this.notifications.notifyPlayers(
        "StorePurchaseCancelled" as e_notification_types_enum,
        {
          title: "Purchase cancelled",
          message: `Your pending purchase of <b>${NotificationsService.escapeHtml(
            productTitle,
          )}</b> was cancelled. <a href="/store">Open Store</a>`,
          role: "user",
          entity_id: orderId,
          steamIds: [steamId],
        },
      );
    } catch (error) {
      this.logger.warn(
        `Store cancel notify failed order=${orderId}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async grantSubscriptionIfNeeded(order: {
    id: string;
    buyer_steam_id: string;
    subscription_tier?: string | null;
    vip_duration?: string | null;
  }) {
    const tier = (order.subscription_tier || "").trim();
    if (tier !== "premium" && tier !== "premium_plus") return;
    const duration = (order.vip_duration || "30d").trim() || "30d";
    try {
      await this.challenges.grantSubscription({
        steamId: String(order.buyer_steam_id),
        tier: tier as ChallengeTier,
        duration,
        orderId: order.id,
      });
    } catch (error) {
      this.logger.error(
        `Subscription grant failed order=${order.id}`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  private async grantVipIfNeeded(order: {
    id: string;
    buyer_steam_id: string;
    vip_server_id: string | null;
    vip_duration: string | null;
    vip_granted_at: string | null;
  }) {
    const serverId = order.vip_server_id?.trim();
    const duration = (order.vip_duration || "").trim();
    if (!serverId || !duration) return;

    const steamId = String(order.buyer_steam_id).trim();
    if (!/^\d{15,20}$/.test(steamId)) {
      this.logger.error(
        `VIP grant skipped: invalid steam id for order ${order.id}`,
      );
      return;
    }

    if (!VIP_DURATION.test(duration)) {
      this.logger.error(
        `VIP grant skipped: bad duration "${duration}" for order ${order.id}`,
      );
      return;
    }

    if (!order.vip_granted_at) {
      try {
        const rcon = await this.rcon.connect(serverId);
        if (!rcon) {
          this.logger.error(
            `VIP grant failed: RCON unavailable server=${serverId} order=${order.id}`,
          );
        } else {
          const reply = await rcon.send(`css_addvip ${steamId} ${duration}`);
          this.logger.log(
            `VIP granted steam=${steamId} server=${serverId} duration=${duration} reply=${String(reply || "").slice(0, 200)}`,
          );
          await this.postgres.query(
            `UPDATE store_orders SET vip_granted_at = now() WHERE id = $1 AND vip_granted_at IS NULL`,
            [order.id],
          );
        }
      } catch (error) {
        this.logger.error(
          `VIP grant RCON error order=${order.id} server=${serverId}`,
          error instanceof Error ? error.stack : error,
        );
      }
    }

    await this.upsertVipGrant({
      steamId,
      serverId,
      orderId: order.id,
      duration,
    });
  }

  public async adminListVips(serverId: string) {
    StoreService.requireUuid(serverId);
    return this.postgres.query<
      Array<{
        steam_id: string;
        name: string | null;
        avatar_url: string | null;
        expires_at: string | null;
        granted_at: string;
        from_store: boolean;
      }>
    >(
      `SELECT g.steam_id::text AS steam_id, p.name, p.avatar_url, g.expires_at,
              g.granted_at, g.order_id IS NOT NULL AS from_store
       FROM store_vip_grants g
       LEFT JOIN players p ON p.steam_id = g.steam_id
       WHERE g.server_id = $1::uuid
         AND (g.expires_at IS NULL OR g.expires_at > now())
       ORDER BY g.expires_at ASC NULLS LAST`,
      [serverId],
    );
  }

  public async adminGrantVip(
    serverId: string,
    steamIdInput: unknown,
    durationInput: unknown,
  ) {
    StoreService.requireUuid(serverId);
    const steamId = await resolveSteamId64(
      steamIdInput,
      this.configService.get<SteamConfig>("steam")?.steamApiKey,
    );
    const duration = String(durationInput || "")
      .trim()
      .toLowerCase();
    if (!VIP_DURATION.test(duration)) {
      throw new BadRequestException(
        "Invalid duration. Use 30m, 12h, 7d, 2w, 1mo or perm",
      );
    }
    await this.sendVipRcon(serverId, `css_addvip ${steamId} ${duration}`);

    const listed = await this.isRegisteredPlayer(steamId);
    if (listed) {
      await this.upsertVipGrant({ steamId, serverId, orderId: null, duration });
    }
    return { listed, vips: await this.adminListVips(serverId) };
  }

  public async adminRevokeVip(serverId: string, steamIdInput: unknown) {
    StoreService.requireUuid(serverId);
    const steamId = StoreService.parseSteamId(steamIdInput);
    await this.sendVipRcon(serverId, `css_removevip ${steamId}`);
    await this.postgres.query(
      `DELETE FROM store_vip_grants WHERE server_id = $1::uuid AND steam_id = $2::bigint`,
      [serverId, steamId],
    );
    return { vips: await this.adminListVips(serverId) };
  }

  /**
   * Makes the panel list match the server's own vip_database.json, which also
   * holds VIPs granted from the console that the panel never saw.
   */
  public async adminSyncVips(serverId: string) {
    StoreService.requireUuid(serverId);
    const reply = await this.sendVipRcon(serverId, "css_listvip");
    if (!/Active VIPs|No active VIP grants/i.test(reply)) {
      throw new BadRequestException(
        "The server did not answer css_listvip. Is YGuardVIP running on it?",
      );
    }

    const onServer = new Map<string, string | null>();
    for (const line of reply.split(/\r?\n/)) {
      const match = line.match(/\b(7656119\d{10})\b\s*\S\s*([^\u00b7|]+)/);
      if (match) {
        onServer.set(match[1], StoreService.remainingToExpiry(match[2]));
      }
    }

    let imported = 0;
    let unregistered = 0;
    for (const [steamId, expiresAt] of onServer) {
      if (!(await this.isRegisteredPlayer(steamId))) {
        unregistered += 1;
        continue;
      }
      await this.postgres.query(
        `INSERT INTO store_vip_grants (steam_id, server_id, expires_at)
         VALUES ($1::bigint, $2::uuid, $3::timestamptz)
         ON CONFLICT (steam_id, server_id) DO UPDATE
         SET expires_at = EXCLUDED.expires_at, updated_at = now()`,
        [steamId, serverId, expiresAt],
      );
      imported += 1;
    }

    const removed = await this.postgres.query<Array<{ steam_id: string }>>(
      `DELETE FROM store_vip_grants
       WHERE server_id = $1::uuid
         AND NOT (steam_id::text = ANY($2::text[]))
       RETURNING steam_id::text AS steam_id`,
      [serverId, [...onServer.keys()]],
    );

    return {
      imported,
      removed: removed.length,
      unregistered,
      vips: await this.adminListVips(serverId),
    };
  }

  private async sendVipRcon(serverId: string, command: string) {
    const rcon = await this.rcon.connect(serverId).catch((): null => null);
    if (!rcon) {
      throw new BadRequestException(
        "The server is not reachable over RCON. Is it online?",
      );
    }
    return String((await rcon.send(command)) ?? "");
  }

  private async isRegisteredPlayer(steamId: string) {
    const rows = await this.postgres.query<Array<{ ok: number }>>(
      `SELECT 1 AS ok FROM players WHERE steam_id = $1::bigint`,
      [steamId],
    );
    return rows.length > 0;
  }

  private static requireUuid(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id || "")) {
      throw new NotFoundException("Server not found");
    }
  }

  private static parseSteamId(input: unknown): string {
    const match = String(input ?? "").match(/\b(7656119\d{10})\b/);
    if (!match) {
      throw new BadRequestException(
        "Enter a SteamID64 (7656119...) or a steamcommunity.com/profiles/ link",
      );
    }
    return match[1];
  }

  /** Inverse of YGuardVIP's FormatRemaining: "permanent", "3d 4h", "5h 2m", "40m". */
  private static remainingToExpiry(text: string): string | null {
    const s = text.trim().toLowerCase();
    if (s.startsWith("perm")) return null;
    const days = Number(s.match(/(\d+)\s*d/)?.[1] || 0);
    const hours = Number(s.match(/(\d+)\s*h/)?.[1] || 0);
    const minutes = Number(s.match(/(\d+)\s*m(?!o)/)?.[1] || 0);
    const ms = ((days * 24 + hours) * 60 + minutes) * 60_000;
    return new Date(Date.now() + Math.max(ms, 60_000)).toISOString();
  }

  private async upsertVipGrant(args: {
    steamId: string;
    serverId: string;
    orderId: string | null;
    duration: string;
  }) {
    const expiresAt = StoreService.durationToExpiry(args.duration);
    try {
      await this.postgres.query(
        `INSERT INTO store_vip_grants (steam_id, server_id, order_id, expires_at)
         VALUES ($1::bigint, $2::uuid, $3::uuid, $4::timestamptz)
         ON CONFLICT (steam_id, server_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           expires_at = CASE
             WHEN EXCLUDED.expires_at IS NULL THEN NULL
             WHEN store_vip_grants.expires_at IS NOT NULL
               AND store_vip_grants.expires_at > now()
               AND EXCLUDED.expires_at IS NOT NULL
             THEN store_vip_grants.expires_at
                  + (EXCLUDED.expires_at - now())
             ELSE EXCLUDED.expires_at
           END,
           updated_at = now()`,
        [args.steamId, args.serverId, args.orderId, expiresAt],
      );
    } catch (error) {
      this.logger.warn(
        `VIP grant roster upsert failed order=${args.orderId}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** Convert YGuardVIP duration token to an absolute expiry (UTC ISO), or null for permanent. */
  static durationToExpiry(duration: string): string | null {
    const s = duration.trim().toLowerCase();
    if (
      s === "perm" ||
      s === "permanent" ||
      s === "0" ||
      s === "lifetime" ||
      s === "forever"
    ) {
      return null;
    }
    const m = s.match(
      /^(\d+)\s*(m|min|mins|h|hr|hrs|d|day|days|w|week|weeks|mo|month|months)$/,
    );
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2];
    const ms = /^(m|min|mins)$/.test(unit)
      ? n * 60_000
      : /^(h|hr|hrs)$/.test(unit)
        ? n * 3_600_000
        : /^(d|day|days)$/.test(unit)
          ? n * 86_400_000
          : /^(w|week|weeks)$/.test(unit)
            ? n * 7 * 86_400_000
            : n * 30 * 86_400_000;
    return new Date(Date.now() + ms).toISOString();
  }

  private async sendInvoice(args: {
    chatId: number | string;
    title: string;
    description: string;
    payload: string;
    prices: Array<{ label: string; amount: number }>;
    providerToken: string;
  }) {
    const prices = args.prices.filter((p) => p.amount >= 0);
    if (!prices.length) {
      throw new BadRequestException("Invoice has no line items");
    }
    const body = {
      chat_id: args.chatId,
      title: args.title.slice(0, 32),
      description: args.description.slice(0, 255),
      payload: args.payload,
      provider_token: args.providerToken,
      currency: "IRR",
      prices: prices.map((p) => ({
        label: p.label.slice(0, 32),
        amount: p.amount,
      })),
    };

    await this.baleApi("sendInvoice", body);
  }

  private async answerPreCheckoutQuery(
    id: string,
    ok: boolean,
    errorMessage?: string,
  ) {
    await this.baleApi("answerPreCheckoutQuery", {
      pre_checkout_query_id: id,
      ok,
      ...(ok ? {} : { error_message: errorMessage || "Payment rejected" }),
    });
  }

  private async baleApi(method: string, body: Record<string, unknown>) {
    const bale = await this.resolveBale();
    if (!bale.botToken) {
      throw new ServiceUnavailableException("Bale bot token missing");
    }
    const url = `https://tapi.bale.ai/bot${bale.botToken}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
    };
    if (!res.ok || data.ok === false) {
      this.logger.error(`Bale API ${method} failed`, data);
      throw new ServiceUnavailableException(
        data.description || `Bale API ${method} failed`,
      );
    }
    return data;
  }

  private buildDeepLink(orderId: string, botUsername: string): string {
    const start = `pay_${orderId.replace(/-/g, "")}`;
    const username = (botUsername || "").replace(/^@/, "");
    if (username) {
      return `https://ble.ir/${username}?start=${start}`;
    }
    return `bale://start?payload=${start}`;
  }

  private expandOrderId(compact: string): string | null {
    if (!/^[a-f0-9]{32}$/i.test(compact)) {
      return null;
    }
    const hex = compact.toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
