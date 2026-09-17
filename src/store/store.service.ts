import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { PostgresService } from "../postgres/postgres.service";
import { BaleConfig } from "../configs/types/BaleConfig";
import { AppConfig } from "../configs/types/AppConfig";

import { YpointService } from "../ypoint/ypoint.service";
import { RconService } from "../rcon/rcon.service";
import { NotificationsService } from "../notifications/notifications.service";
import { e_notification_types_enum } from "../../generated/schema";

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
  ) {
    this.envBale = this.configService.get<BaleConfig>("bale");
    this.app = this.configService.get<AppConfig>("app");
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

  public async checkout(productId: string, buyerSteamId: string) {
    const bale = await this.resolveBale();
    if (!bale.botToken || !bale.providerToken) {
      throw new ServiceUnavailableException(
        "Bale Pay is not configured. Set BALE_BOT_TOKEN and BALE_PROVIDER_TOKEN.",
      );
    }

    const products = await this.postgres.query<StoreProductRow[]>(
      `SELECT id, title, slug, description, price_irr, image_url, active
       FROM store_products
       WHERE id = $1
       LIMIT 1`,
      [productId],
    );
    const product = products.at(0);
    if (!product || !product.active) {
      throw new NotFoundException("Product not found");
    }
    if (product.price_irr < 0) {
      throw new BadRequestException("Invalid product price");
    }

    const orderId = randomUUID();
    const payload = `store:${orderId}`;

    await this.postgres.query(
      `INSERT INTO store_orders
        (id, product_id, buyer_steam_id, amount_irr, status, bale_payload)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [orderId, product.id, buyerSteamId, product.price_irr, payload],
    );

    const deepLink = this.buildDeepLink(orderId, bale.botUsername);

    return {
      orderId,
      amountIrr: product.price_irr,
      productTitle: product.title,
      deepLink,
      botUsername: bale.botUsername || null,
      // Client opens Bale; /start pay_<orderId> triggers invoice send.
      startParam: `pay_${orderId.replace(/-/g, "")}`,
    };
  }

  public async handleStartPay(chatId: number | string, orderKey: string) {
    const orderId = this.expandOrderId(orderKey);
    if (!orderId) {
      throw new BadRequestException("Invalid order");
    }

    // Always re-read the live product price so admin edits apply to unpaid invoices.
    const synced = await this.postgres.query<
      Array<{
        id: string;
        status: string;
        amount_irr: number;
        bale_payload: string;
        title: string;
        description: string;
      }>
    >(
      `UPDATE store_orders o
       SET amount_irr = p.price_irr
       FROM store_products p
       WHERE o.id = $1
         AND p.id = o.product_id
         AND o.status = 'pending'
         AND p.active = true
       RETURNING o.id, o.status, o.amount_irr, o.bale_payload,
                 p.title, p.description`,
      [orderId],
    );

    const order = synced.at(0);
    if (!order) {
      const existing = await this.postgres.query<
        Array<{ status: string }>
      >(
        `SELECT status FROM store_orders WHERE id = $1 LIMIT 1`,
        [orderId],
      );
      const row = existing.at(0);
      if (!row) {
        throw new NotFoundException("Order not found");
      }
      throw new BadRequestException(`Order is ${row.status}`);
    }

    const toman = Math.round(Number(order.amount_irr) / 10);
    const baseDescription = (order.description || order.title).slice(0, 200);
    const description =
      `${baseDescription} · ${toman.toLocaleString("en-US")} تومان`.slice(
        0,
        255,
      );

    await this.sendInvoice({
      chatId,
      title: order.title,
      description,
      payload: order.bale_payload,
      amountIrr: order.amount_irr,
      providerToken: (await this.resolveBale()).providerToken,
    });

    return { ok: true };
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
                 p.vip_server_id, p.vip_duration, o.vip_granted_at, p.title AS product_title`,
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
        }>
      >(
        `SELECT o.id, o.buyer_steam_id::text, p.vip_server_id, p.vip_duration,
                o.vip_granted_at, p.title AS product_title, p.ypoint_amount
         FROM store_orders o
         JOIN store_products p ON p.id = o.product_id
         WHERE o.bale_payload = $1 AND o.status = 'paid'
         LIMIT 1`,
        [payload],
      );
      const paid = existing.at(0);
      if (paid) {
        await this.grantVipIfNeeded(paid);
        await this.notifyPurchasePaid(paid);
      } else {
        this.logger.log(`Store order already paid or missing payload=${payload}`);
      }
      return;
    }

    const amount = Number(order.ypoint_amount || 0);
    if (amount > 0) {
      await this.ypoint.credit({
        steamId: order.buyer_steam_id,
        amount,
        reason: "store_purchase",
        refType: "store_order",
        refId: order.id,
      });
    }

    await this.grantVipIfNeeded(order);
    await this.notifyPurchasePaid(order);

    this.logger.log(`Store order paid payload=${payload} charge=${chargeId}`);
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

      const bits: string[] = [
        `Payment for <b>${NotificationsService.escapeHtml(order.product_title)}</b> succeeded.`,
      ];
      const yp = Number(order.ypoint_amount || 0);
      if (yp > 0) bits.push(`+${yp} Ypoints credited.`);
      if (order.vip_server_id && order.vip_duration) {
        bits.push(`VIP ${NotificationsService.escapeHtml(order.vip_duration)} activated on the server.`);
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
    amountIrr: number;
    providerToken: string;
  }) {
    const body = {
      chat_id: args.chatId,
      title: args.title.slice(0, 32),
      description: args.description.slice(0, 255),
      payload: args.payload,
      provider_token: args.providerToken,
      currency: "IRR",
      prices: [
        {
          label: args.title.slice(0, 32),
          amount: args.amountIrr,
        },
      ],
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
