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
import { S3Service } from "../s3/s3.service";

import { YpointService } from "../ypoint/ypoint.service";
import { RconService } from "../rcon/rcon.service";
import { NotificationsService } from "../notifications/notifications.service";
import { e_notification_types_enum } from "../../generated/schema";
import { ChallengesService } from "../challenges/challenges.service";
import type { ChallengeTier } from "../challenges/challenge-catalog";

const IMAGE_PREFIX = "store";
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
    private readonly rcon: RconService,
    private readonly notifications: NotificationsService,
    private readonly s3: S3Service,
    private readonly challenges: ChallengesService,
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
    const rows = await this.postgres.query<Array<{ name: string; value: string }>>(
      `SELECT name, value FROM settings
       WHERE name = ANY($1::text[])`,
      [["bale.bot_token", "bale.provider_token", "bale.bot_username", "bale.webhook_secret"]],
    );
    const map = Object.fromEntries(rows.map((r) => [r.name, r.value ?? ""]));
    return {
      botToken: this.envBale.botToken || map["bale.bot_token"] || "",
      providerToken: this.envBale.providerToken || map["bale.provider_token"] || "",
      botUsername: this.envBale.botUsername || map["bale.bot_username"] || "",
      webhookSecret: this.envBale.webhookSecret || map["bale.webhook_secret"] || "",
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

    const uniqueIds = [...new Set(rawIds)];
    const products = await this.postgres.query<StoreProductRow[]>(
      `SELECT id, title, slug, description, price_irr, image_url, active,
              ypoint_amount, vip_server_id, vip_duration, subscription_tier
       FROM store_products
       WHERE id = ANY($1::uuid[])
         AND active = true`,
      [uniqueIds],
    );
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
      subscription_tier: p.subscription_tier,
    }));
    const amountIrr = cartItems.reduce((sum, i) => sum + i.price_irr, 0);
    const primary = ordered[0];
    const orderId = randomUUID();
    const payload = `store:${orderId}`;

    await this.cancelPendingOrders(buyerSteamId);

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
      description =
        `${cart.map((i) => i.title).join(" · ").slice(0, 180)} · ${toman.toLocaleString("en-US")} تومان`.slice(
          0,
          255,
        );
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
      update?.message?.successful_payment ||
      update?.successful_payment;
    if (payment) {
      await this.markPaid(
        String(payment.invoice_payload || ""),
        String(payment.telegram_payment_charge_id || payment.provider_payment_charge_id || ""),
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
                 p.vip_server_id, p.vip_duration, o.vip_granted_at, p.title AS product_title,
                 p.subscription_tier, o.cart_items`,
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
        }>
      >(
        `SELECT o.id, o.buyer_steam_id::text, p.vip_server_id, p.vip_duration,
                o.vip_granted_at, p.title AS product_title, p.ypoint_amount,
                p.subscription_tier, o.cart_items
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
        this.logger.log(`Store order already paid or missing payload=${payload}`);
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
       RETURNING o.id, p.title AS product_title`,
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
        bits.push(`Challenges unlocked. <a href="/challenges">Open Challenges</a>`);
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

    if (
      !/^(perm|permanent|0|lifetime|forever|\d+\s*(m|min|mins|h|hr|hrs|d|day|days|w|week|weeks|mo|month|months))$/i.test(
        duration,
      )
    ) {
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

  private async upsertVipGrant(args: {
    steamId: string;
    serverId: string;
    orderId: string;
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

  private async answerPreCheckoutQuery(id: string, ok: boolean, errorMessage?: string) {
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
