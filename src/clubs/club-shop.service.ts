import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { PostgresService } from "../postgres/postgres.service";
import { YpointService } from "../ypoint/ypoint.service";
import { IrrService } from "../irr/irr.service";
import { RconService } from "../rcon/rcon.service";
import { BaleConfig } from "../configs/types/BaleConfig";
import { AppConfig } from "../configs/types/AppConfig";
import { User } from "../auth/types/User";
import { ClubsService } from "./clubs.service";

export type ClubShopKind = "club_vip" | "public_vip" | "custom";
export type ClubShopDuration = "7d" | "30d" | "90d";

export type ClubShopProductRow = {
  id: string;
  club_id: string;
  kind: ClubShopKind;
  title: string | null;
  description: string | null;
  enabled: boolean;
  price_7d_irr: number;
  price_30d_irr: number;
  price_90d_irr: number;
  ypoint_enabled: boolean;
  price_7d_ypoint: number;
  price_30d_ypoint: number;
  price_90d_ypoint: number;
  sort_order: number;
};

@Injectable()
export class ClubShopService {
  private readonly envBale: BaleConfig;
  private readonly app: AppConfig;

  constructor(
    private readonly postgres: PostgresService,
    private readonly configService: ConfigService,
    private readonly logger: Logger,
    private readonly ypoint: YpointService,
    private readonly irr: IrrService,
    private readonly rcon: RconService,
    private readonly clubs: ClubsService,
  ) {
    this.envBale = this.configService.get<BaleConfig>("bale");
    this.app = this.configService.get<AppConfig>("app");
  }

  private assertUuid(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id || "")) {
      throw new BadRequestException("Invalid id");
    }
  }

  private parseAmount(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
    const fa = "۰۱۲۳۴۵۶۷۸۹";
    const ar = "٠١٢٣٤٥٦٧٨٩";
    const raw = String(value ?? "")
      .trim()
      .replace(/[۰-۹]/g, (d) => String(fa.indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String(ar.indexOf(d)))
      .replace(/[^\d.-]/g, "");
    if (!raw) return 0;
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) ? n : 0;
  }

  private priceCap(value: unknown) {
    const n = this.parseAmount(value);
    if (n < 0) return 0;
    return Math.min(500_000_000, n);
  }

  private ypCap(value: unknown) {
    const n = this.parseAmount(value);
    if (n < 0) return 0;
    return Math.min(10_000_000, n);
  }

  private durationDays(duration: ClubShopDuration) {
    if (duration === "7d") return 7;
    if (duration === "90d") return 90;
    return 30;
  }

  private async ensureBuiltins(clubId: string) {
    const existing = await this.postgres.query<Array<{ kind: string }>>(
      `SELECT kind FROM public.club_shop_products
        WHERE club_id = $1::uuid AND kind IN ('club_vip', 'public_vip')`,
      [clubId],
    );
    const have = new Set(existing.map((r) => r.kind));
    if (!have.has("club_vip")) {
      await this.postgres.query(
        `INSERT INTO public.club_shop_products (club_id, kind, enabled, sort_order)
         VALUES ($1::uuid, 'club_vip', false, 0)`,
        [clubId],
      );
    }
    if (!have.has("public_vip")) {
      await this.postgres.query(
        `INSERT INTO public.club_shop_products (club_id, kind, enabled, sort_order)
         VALUES ($1::uuid, 'public_vip', false, 1)`,
        [clubId],
      );
    }
  }

  private async requireManageShop(clubId: string, user: User) {
    const steamId = String(user.steam_id);
    // Match web club admin gate: owner, site admin, level >= 8, or manage_settings.
    if (String(user.role || "") === "administrator") return;
    const rows = await this.postgres.query<
      Array<{ owner_steam_id: string }>
    >(
      `SELECT owner_steam_id::text FROM public.clubs WHERE id = $1::uuid`,
      [clubId],
    );
    const row = rows.at(0);
    if (!row) throw new NotFoundException("Club not found");
    if (row.owner_steam_id === steamId) return;
    if (await this.clubs.memberHasPerm(clubId, steamId, "manage_settings")) {
      return;
    }
    const levelRows = await this.postgres.query<Array<{ level: number }>>(
      `SELECT level::int AS level
         FROM public.club_members
        WHERE club_id = $1::uuid AND steam_id = $2::bigint
        LIMIT 1`,
      [clubId, steamId],
    );
    if ((Number(levelRows.at(0)?.level) || 0) >= 8) return;
    throw new ForbiddenException("Missing manage_settings permission");
  }

  public async getShopForStaff(clubId: string, user: User) {
    this.assertUuid(clubId);
    await this.requireManageShop(clubId, user);
    return this.getShop(clubId, { manage: true });
  }

  public async getShop(clubId: string, opts?: { manage?: boolean }) {
    this.assertUuid(clubId);
    await this.ensureBuiltins(clubId);
    const products = await this.postgres.query<ClubShopProductRow[]>(
      `SELECT id::text, club_id::text, kind, title, description, enabled,
              price_7d_irr::bigint AS price_7d_irr,
              price_30d_irr::bigint AS price_30d_irr,
              price_90d_irr::bigint AS price_90d_irr,
              ypoint_enabled,
              price_7d_ypoint, price_30d_ypoint, price_90d_ypoint,
              sort_order
         FROM public.club_shop_products
        WHERE club_id = $1::uuid
        ORDER BY sort_order ASC, created_at ASC`,
      [clubId],
    );

    const servers = await this.postgres.query<
      Array<{ id: string; label: string }>
    >(
      `SELECT id::text, COALESCE(NULLIF(label, ''), id::text) AS label
         FROM public.servers
        WHERE club_id = $1::uuid
        ORDER BY label ASC NULLS LAST`,
      [clubId],
    );

    const mapped = products.map((p) => this.serializeProduct(p, !!opts?.manage));
    return {
      products: opts?.manage
        ? mapped
        : mapped.filter((p) => p.enabled && p.packages.length > 0),
      servers,
      limits: { max_custom: 2, max_total: 4 },
      custom_count: products.filter((p) => p.kind === "custom").length,
    };
  }

  private asBool(value: unknown): boolean {
    return (
      value === true ||
      value === 1 ||
      value === "1" ||
      value === "t" ||
      value === "true"
    );
  }

  private serializeProduct(p: ClubShopProductRow, manage: boolean) {
    const enabled = this.asBool(p.enabled);
    const ypointEnabled = this.asBool(p.ypoint_enabled);
    const packages: Array<{
      duration: ClubShopDuration;
      price_irr: number;
      price_ypoint: number | null;
    }> = [];
    const push = (duration: ClubShopDuration, irr: number, yp: number) => {
      if (!(irr > 0)) return;
      packages.push({
        duration,
        price_irr: irr,
        price_ypoint: ypointEnabled && yp > 0 ? yp : null,
      });
    };
    push("7d", Number(p.price_7d_irr), Number(p.price_7d_ypoint));
    push("30d", Number(p.price_30d_irr), Number(p.price_30d_ypoint));
    push("90d", Number(p.price_90d_irr), Number(p.price_90d_ypoint));

    return {
      id: p.id,
      kind: p.kind,
      title: p.title,
      description: p.description,
      enabled,
      ypoint_enabled: ypointEnabled,
      price_7d_irr: Number(p.price_7d_irr),
      price_30d_irr: Number(p.price_30d_irr),
      price_90d_irr: Number(p.price_90d_irr),
      price_7d_ypoint: Number(p.price_7d_ypoint),
      price_30d_ypoint: Number(p.price_30d_ypoint),
      price_90d_ypoint: Number(p.price_90d_ypoint),
      sort_order: p.sort_order,
      packages,
    };
  }

  public async saveShop(
    clubId: string,
    user: User,
    body: {
      products?: Array<{
        id?: string;
        kind?: ClubShopKind;
        title?: string | null;
        description?: string | null;
        enabled?: boolean;
        ypoint_enabled?: boolean;
        price_7d_irr?: number;
        price_30d_irr?: number;
        price_90d_irr?: number;
        price_7d_ypoint?: number;
        price_30d_ypoint?: number;
        price_90d_ypoint?: number;
        delete?: boolean;
      }>;
    },
  ) {
    this.assertUuid(clubId);
    await this.requireManageShop(clubId, user);
    await this.ensureBuiltins(clubId);

    const items = Array.isArray(body?.products) ? body.products : [];
    for (const item of items) {
      if (item.delete && item.id) {
        this.assertUuid(item.id);
        await this.postgres.query(
          `DELETE FROM public.club_shop_products
            WHERE id = $1::uuid AND club_id = $2::uuid AND kind = 'custom'`,
          [item.id, clubId],
        );
        continue;
      }

      const kind = (item.kind || "") as ClubShopKind;
      if (!["club_vip", "public_vip", "custom"].includes(kind)) {
        throw new BadRequestException("Invalid product kind");
      }

      const payload = {
        title:
          kind === "custom"
            ? String(item.title || "").trim().slice(0, 80) || null
            : item.title != null
              ? String(item.title).trim().slice(0, 80) || null
              : null,
        description:
          item.description != null
            ? String(item.description).trim().slice(0, 500) || null
            : null,
        enabled: this.asBool(item.enabled),
        ypoint_enabled: this.asBool(item.ypoint_enabled),
        price_7d_irr: this.priceCap(item.price_7d_irr),
        price_30d_irr: this.priceCap(item.price_30d_irr),
        price_90d_irr: this.priceCap(item.price_90d_irr),
        price_7d_ypoint: this.ypCap(item.price_7d_ypoint),
        price_30d_ypoint: this.ypCap(item.price_30d_ypoint),
        price_90d_ypoint: this.ypCap(item.price_90d_ypoint),
      };

      if (kind === "custom" && !payload.title) {
        throw new BadRequestException("Custom products need a title");
      }

      if (item.id) {
        this.assertUuid(item.id);
        const updated = await this.postgres.query<Array<{ id: string }>>(
          `UPDATE public.club_shop_products
              SET title = CASE WHEN kind = 'custom' THEN $3 ELSE title END,
                  description = $4,
                  enabled = $5,
                  ypoint_enabled = $6,
                  price_7d_irr = $7,
                  price_30d_irr = $8,
                  price_90d_irr = $9,
                  price_7d_ypoint = $10,
                  price_30d_ypoint = $11,
                  price_90d_ypoint = $12,
                  updated_at = now()
            WHERE id = $1::uuid AND club_id = $2::uuid
            RETURNING id::text`,
          [
            item.id,
            clubId,
            payload.title,
            payload.description,
            payload.enabled,
            payload.ypoint_enabled,
            payload.price_7d_irr,
            payload.price_30d_irr,
            payload.price_90d_irr,
            payload.price_7d_ypoint,
            payload.price_30d_ypoint,
            payload.price_90d_ypoint,
          ],
        );
        if (updated.length > 0) continue;
        // Stale id (e.g. builtins recreated) — fall through to kind upsert.
        if (kind === "custom") {
          throw new NotFoundException("Shop product not found");
        }
      }
      if (kind === "custom" && !item.id) {
        const count = await this.postgres.query<Array<{ n: number }>>(
          `SELECT COUNT(*)::int AS n FROM public.club_shop_products
            WHERE club_id = $1::uuid AND kind = 'custom'`,
          [clubId],
        );
        if ((count.at(0)?.n || 0) >= 2) {
          throw new BadRequestException(
            "Club shop allows at most 2 custom products",
          );
        }
        await this.postgres.query(
          `INSERT INTO public.club_shop_products
             (club_id, kind, title, description, enabled, ypoint_enabled,
              price_7d_irr, price_30d_irr, price_90d_irr,
              price_7d_ypoint, price_30d_ypoint, price_90d_ypoint, sort_order)
           VALUES ($1::uuid, 'custom', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 10)`,
          [
            clubId,
            payload.title,
            payload.description,
            payload.enabled,
            payload.ypoint_enabled,
            payload.price_7d_irr,
            payload.price_30d_irr,
            payload.price_90d_irr,
            payload.price_7d_ypoint,
            payload.price_30d_ypoint,
            payload.price_90d_ypoint,
          ],
        );
      } else {
        await this.postgres.query(
          `UPDATE public.club_shop_products
              SET description = COALESCE($3, description),
                  enabled = $4,
                  ypoint_enabled = $5,
                  price_7d_irr = $6,
                  price_30d_irr = $7,
                  price_90d_irr = $8,
                  price_7d_ypoint = $9,
                  price_30d_ypoint = $10,
                  price_90d_ypoint = $11,
                  updated_at = now()
            WHERE club_id = $1::uuid AND kind = $2`,
          [
            clubId,
            kind,
            payload.description,
            payload.enabled,
            payload.ypoint_enabled,
            payload.price_7d_irr,
            payload.price_30d_irr,
            payload.price_90d_irr,
            payload.price_7d_ypoint,
            payload.price_30d_ypoint,
            payload.price_90d_ypoint,
          ],
        );
      }
    }

    return this.getShop(clubId, { manage: true });
  }

  private async resolveBale() {
    const rows = await this.postgres.query<
      Array<{ name: string; value: string | null }>
    >(
      `SELECT name, value FROM settings
        WHERE name IN ('bale.bot_token','bale.provider_token','bale.bot_username')`,
    ).catch((): Array<{ name: string; value: string | null }> => []);
    const map = Object.fromEntries(rows.map((r) => [r.name, r.value ?? ""]));
    return {
      botToken: this.envBale?.botToken || map["bale.bot_token"] || "",
      providerToken:
        this.envBale?.providerToken || map["bale.provider_token"] || "",
      botUsername:
        this.envBale?.botUsername || map["bale.bot_username"] || "",
    };
  }

  private buildDeepLink(orderId: string, botUsername: string) {
    // Must match StoreService + Bale webhook: /start pay_<uuid32>
    const start = `pay_${orderId.replace(/-/g, "")}`;
    const username = (botUsername || "").replace(/^@/, "");
    if (username) {
      return `https://ble.ir/${username}?start=${start}`;
    }
    return `bale://start?payload=${start}`;
  }

  private async ensureCarrier(): Promise<{ id: string }> {
    const [existing] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id FROM store_products WHERE slug = 'club-shop' LIMIT 1`,
    );
    if (existing?.id) return existing;
    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO store_products
         (title, slug, description, price_irr, sort_order, active)
       VALUES ('Club shop (internal)', 'club-shop',
               'Internal bill carrier for club shop sales.', 0, 9998, false)
       ON CONFLICT (slug) DO UPDATE SET active = false
       RETURNING id`,
    );
    if (!row?.id) {
      throw new ServiceUnavailableException("Club shop bill product missing");
    }
    return row;
  }

  private pickPrice(
    product: ClubShopProductRow,
    duration: ClubShopDuration,
    payWith: "bale" | "ypoint",
  ) {
    if (payWith === "ypoint") {
      if (!this.asBool(product.ypoint_enabled)) {
        throw new BadRequestException("YPoint is disabled for this product");
      }
      const yp =
        duration === "7d"
          ? Number(product.price_7d_ypoint)
          : duration === "90d"
            ? Number(product.price_90d_ypoint)
            : Number(product.price_30d_ypoint);
      if (!(yp > 0)) {
        throw new BadRequestException("That YPoint package is not available");
      }
      return { amountIrr: 0, amountYpoint: yp };
    }
    const irr =
      duration === "7d"
        ? Number(product.price_7d_irr)
        : duration === "90d"
          ? Number(product.price_90d_irr)
          : Number(product.price_30d_irr);
    if (!(irr > 0)) {
      throw new BadRequestException("That package is not available");
    }
    return { amountIrr: irr, amountYpoint: 0 };
  }

  public async checkout(
    clubId: string,
    user: User,
    body: {
      product_id?: string;
      duration?: string;
      payWith?: "bale" | "ypoint";
      server_id?: string | null;
      termsAccepted?: boolean;
    },
  ) {
    this.assertUuid(clubId);
    if (!body?.termsAccepted) {
      throw new BadRequestException("Terms must be accepted before checkout");
    }
    const productId = String(body.product_id || "");
    this.assertUuid(productId);
    const duration = String(body.duration || "")
      .trim()
      .toLowerCase() as ClubShopDuration;
    if (!["7d", "30d", "90d"].includes(duration)) {
      throw new BadRequestException("Duration must be 7d, 30d, or 90d");
    }
    const payWith = body.payWith === "ypoint" ? "ypoint" : "bale";
    const buyerSteamId = String(user.steam_id);

    await this.ensureBuiltins(clubId);
    const [product] = await this.postgres.query<ClubShopProductRow[]>(
      `SELECT id::text, club_id::text, kind, title, description, enabled,
              price_7d_irr::bigint AS price_7d_irr,
              price_30d_irr::bigint AS price_30d_irr,
              price_90d_irr::bigint AS price_90d_irr,
              ypoint_enabled,
              price_7d_ypoint, price_30d_ypoint, price_90d_ypoint,
              sort_order
         FROM public.club_shop_products
        WHERE id = $1::uuid AND club_id = $2::uuid`,
      [productId, clubId],
    );
    if (!product || !this.asBool(product.enabled)) {
      throw new NotFoundException("Product is not for sale");
    }

    let serverId: string | null = null;
    if (product.kind === "public_vip") {
      serverId = String(body.server_id || "");
      this.assertUuid(serverId);
      const ok = await this.postgres.query<Array<{ id: string }>>(
        `SELECT id::text FROM public.servers
          WHERE id = $1::uuid AND club_id = $2::uuid`,
        [serverId, clubId],
      );
      if (!ok.length) {
        throw new BadRequestException("Pick a club server for Public VIP");
      }
    }

    if (product.kind === "club_vip") {
      const member = await this.postgres.query<Array<{ ok: number }>>(
        `SELECT 1 AS ok FROM public.club_members
          WHERE club_id = $1::uuid AND steam_id = $2::bigint`,
        [clubId, buyerSteamId],
      );
      if (!member.length) {
        throw new BadRequestException(
          "Join the club before buying Club VIP",
        );
      }
    }

    const { amountIrr, amountYpoint } = this.pickPrice(
      product,
      duration,
      payWith,
    );

    const titleBase =
      product.kind === "custom"
        ? product.title || "Club item"
        : product.kind === "club_vip"
          ? "Club VIP"
          : "Public VIP";
    const title = `${titleBase} ${duration}`.slice(0, 120);

    if (payWith === "ypoint") {
      const clubOrderId = randomUUID();
      await this.ypoint.debitMany({
        steamIds: [buyerSteamId],
        amount: amountYpoint,
        reason: "club_shop",
        refType: "club_shop_order",
        refId: clubOrderId,
      });

      await this.postgres.query(
        `INSERT INTO public.club_shop_orders
           (id, club_id, product_id, kind, product_title, buyer_steam_id,
            duration, server_id, amount_irr, amount_ypoint, payment_method,
            status, fulfillment_status, paid_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::bigint, $7, $8::uuid,
                 0, $9, 'ypoint', 'paid',
                 CASE WHEN $4 = 'custom' THEN 'pending' ELSE 'none' END,
                 now())`,
        [
          clubOrderId,
          clubId,
          product.id,
          product.kind,
          title,
          buyerSteamId,
          duration,
          serverId,
          amountYpoint,
        ],
      );

      await this.fulfillClubShopOrder(clubOrderId);
      await this.creditOwnerYpointShare(clubId, clubOrderId, amountYpoint);

      return {
        orderId: clubOrderId,
        paid: true as const,
        amountIrr: 0,
        amountYpoint,
        productTitle: title,
        deepLink: null as string | null,
      };
    }

    const bale = await this.resolveBale();
    if (!bale.botToken || !bale.providerToken) {
      throw new ServiceUnavailableException(
        "Bale Pay is not configured. Set BALE_BOT_TOKEN and BALE_PROVIDER_TOKEN.",
      );
    }

    const carrier = await this.ensureCarrier();
    const storeOrderId = randomUUID();
    const clubOrderId = randomUUID();
    const payload = `store:${storeOrderId}`;
    const cartItems: Array<Record<string, string | number | null>> = [
      {
        product_id: carrier.id,
        title,
        price_irr: amountIrr,
        ypoint_amount: null,
        vip_server_id: serverId,
        vip_duration: duration,
        subscription_tier: null,
        club_id: clubId,
        club_product_id: product.id,
        club_product_kind: product.kind,
        club_shop_order_id: clubOrderId,
      },
    ];

    await this.postgres.query(
      `INSERT INTO store_orders
         (id, product_id, product_title, buyer_steam_id, amount_irr, status,
          bale_payload, cart_items, terms_accepted_at, hosted_kind,
          payment_method)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7::jsonb, now(), 'club_shop',
               'bale')`,
      [
        storeOrderId,
        carrier.id,
        title,
        buyerSteamId,
        amountIrr,
        payload,
        JSON.stringify(cartItems),
      ],
    );

    await this.postgres.query(
      `INSERT INTO public.club_shop_orders
         (id, club_id, product_id, kind, product_title, buyer_steam_id,
          duration, server_id, amount_irr, amount_ypoint, payment_method,
          store_order_id, status, fulfillment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::bigint, $7, $8::uuid,
               $9, 0, 'bale', $10::uuid, 'pending',
               CASE WHEN $4 = 'custom' THEN 'pending' ELSE 'none' END)`,
      [
        clubOrderId,
        clubId,
        product.id,
        product.kind,
        title,
        buyerSteamId,
        duration,
        serverId,
        amountIrr,
        storeOrderId,
      ],
    );

    return {
      orderId: storeOrderId,
      clubOrderId,
      paid: false as const,
      amountIrr,
      amountYpoint: 0,
      productTitle: title,
      deepLink: this.buildDeepLink(storeOrderId, bale.botUsername),
      botUsername: bale.botUsername || null,
    };
  }

  /** Called from StoreService after Bale marks the store order paid. */
  public async fulfillFromStoreOrder(storeOrderId: string) {
    this.assertUuid(storeOrderId);
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text FROM public.club_shop_orders
        WHERE store_order_id = $1::uuid
        LIMIT 1`,
      [storeOrderId],
    );
    const clubOrderId = rows.at(0)?.id;
    if (!clubOrderId) {
      this.logger.warn(`club_shop store order has no club row: ${storeOrderId}`);
      return;
    }
    await this.postgres.query(
      `UPDATE public.club_shop_orders
          SET status = 'paid', paid_at = COALESCE(paid_at, now())
        WHERE id = $1::uuid AND status = 'pending'`,
      [clubOrderId],
    );
    await this.fulfillClubShopOrder(clubOrderId);
    const [paid] = await this.postgres.query<
      Array<{ club_id: string; amount_irr: number }>
    >(
      `SELECT club_id::text, amount_irr::bigint AS amount_irr
         FROM public.club_shop_orders WHERE id = $1::uuid`,
      [clubOrderId],
    );
    if (paid && Number(paid.amount_irr) > 0) {
      await this.creditOwnerIrr(paid.club_id, clubOrderId, Number(paid.amount_irr));
    }
  }

  private async creditOwnerIrr(
    clubId: string,
    clubOrderId: string,
    amountIrr: number,
  ) {
    const [club] = await this.postgres.query<
      Array<{ owner_steam_id: string; name: string }>
    >(
      `SELECT owner_steam_id::text, name FROM public.clubs WHERE id = $1::uuid`,
      [clubId],
    );
    if (!club?.owner_steam_id || !(amountIrr > 0)) return;
    await this.irr.credit({
      steamId: club.owner_steam_id,
      amountIrr,
      reason: "club_shop_earning",
      refType: "club_shop_earning",
      refId: clubOrderId,
    });
  }

  private async creditOwnerYpointShare(
    clubId: string,
    clubOrderId: string,
    amountYpoint: number,
  ) {
    // YPoint purchases: credit owner the same YPoint amount into ledger as club earning.
    const [club] = await this.postgres.query<
      Array<{ owner_steam_id: string }>
    >(
      `SELECT owner_steam_id::text FROM public.clubs WHERE id = $1::uuid`,
      [clubId],
    );
    if (!club?.owner_steam_id || !(amountYpoint > 0)) return;
    try {
      await this.ypoint.credit({
        steamId: club.owner_steam_id,
        amount: amountYpoint,
        reason: "club_shop_earning",
        refType: "club_shop_earning",
        refId: clubOrderId,
      });
    } catch (error) {
      this.logger.warn(
        `Club shop YPoint owner credit failed order=${clubOrderId}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  public async fulfillClubShopOrder(clubOrderId: string) {
    this.assertUuid(clubOrderId);
    const [order] = await this.postgres.query<
      Array<{
        id: string;
        club_id: string;
        kind: ClubShopKind;
        buyer_steam_id: string;
        duration: ClubShopDuration | null;
        server_id: string | null;
        status: string;
        fulfillment_status: string;
      }>
    >(
      `SELECT id::text, club_id::text, kind, buyer_steam_id::text,
              duration, server_id::text, status, fulfillment_status
         FROM public.club_shop_orders WHERE id = $1::uuid`,
      [clubOrderId],
    );
    if (!order || order.status !== "paid") return;

    if (order.kind === "custom") {
      await this.postgres.query(
        `UPDATE public.club_shop_orders
            SET fulfillment_status = CASE
                  WHEN fulfillment_status = 'done' THEN 'done'
                  ELSE 'pending'
                END
          WHERE id = $1::uuid`,
        [clubOrderId],
      );
      return;
    }

    const duration = (order.duration || "30d") as ClubShopDuration;
    const steamId = order.buyer_steam_id;

    if (order.kind === "club_vip") {
      const days = this.durationDays(duration);
      await this.postgres.query(
        `UPDATE public.club_members
            SET club_vip_until = GREATEST(COALESCE(club_vip_until, now()), now())
                                 + ($3 || ' days')::interval,
                is_vip = true
          WHERE club_id = $1::uuid AND steam_id = $2::bigint`,
        [order.club_id, steamId, String(days)],
      );

      const servers = await this.postgres.query<Array<{ id: string }>>(
        `SELECT id::text FROM public.servers WHERE club_id = $1::uuid`,
        [order.club_id],
      );
      for (const server of servers) {
        await this.grantServerVip(steamId, server.id, duration, clubOrderId);
      }
      await this.clubs.recalculateMemberLevel(order.club_id, steamId);
    }

    if (order.kind === "public_vip" && order.server_id) {
      await this.grantServerVip(
        steamId,
        order.server_id,
        duration,
        clubOrderId,
      );
      await this.clubs.recalculateMemberLevel(order.club_id, steamId);
    }

    await this.postgres.query(
      `UPDATE public.club_shop_orders
          SET fulfillment_status = 'done', fulfilled_at = COALESCE(fulfilled_at, now())
        WHERE id = $1::uuid AND kind <> 'custom'`,
      [clubOrderId],
    );
  }

  private async grantServerVip(
    steamId: string,
    serverId: string,
    duration: ClubShopDuration,
    orderId: string,
  ) {
    const expiresAt = new Date(
      Date.now() + this.durationDays(duration) * 86400_000,
    ).toISOString();
    try {
      await this.postgres.query(
        `INSERT INTO store_vip_grants (steam_id, server_id, order_id, expires_at)
         VALUES ($1::bigint, $2::uuid, NULL, $3::timestamptz)
         ON CONFLICT (steam_id, server_id) DO UPDATE SET
           expires_at = CASE
             WHEN store_vip_grants.expires_at IS NOT NULL
               AND store_vip_grants.expires_at > now()
             THEN store_vip_grants.expires_at
                  + (EXCLUDED.expires_at - now())
             ELSE EXCLUDED.expires_at
           END,
           updated_at = now()`,
        [steamId, serverId, expiresAt],
      );
    } catch (error) {
      this.logger.warn(
        `club shop VIP grant upsert failed order=${orderId} server=${serverId}`,
        error instanceof Error ? error.message : error,
      );
    }
    try {
      const rcon = await this.rcon
        .connect(serverId)
        .catch((): null => null);
      if (rcon) {
        await rcon.send(`css_addvip ${steamId} ${duration}`);
      }
    } catch (error) {
      this.logger.warn(
        `club shop css_addvip failed order=${orderId} server=${serverId}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  public async listOrders(clubId: string, user: User) {
    this.assertUuid(clubId);
    await this.requireManageShop(clubId, user);
    return this.postgres.query(
      `SELECT o.id::text, o.kind, o.product_title, o.buyer_steam_id::text,
              o.duration, o.server_id::text, o.amount_irr::bigint AS amount_irr,
              o.amount_ypoint, o.payment_method, o.status, o.fulfillment_status,
              o.created_at, o.paid_at, o.fulfilled_at,
              p.name AS buyer_name, p.avatar_url AS buyer_avatar_url
         FROM public.club_shop_orders o
         LEFT JOIN public.players p ON p.steam_id = o.buyer_steam_id
        WHERE o.club_id = $1::uuid
        ORDER BY o.created_at DESC
        LIMIT 100`,
      [clubId],
    );
  }

  /** Buyer's own club-shop purchases across all clubs. */
  public async listMyPurchases(user: User) {
    const steamId = String(user.steam_id);
    return this.postgres.query(
      `SELECT o.id::text, o.club_id::text, o.kind, o.product_title,
              o.duration, o.server_id::text,
              o.amount_irr::bigint AS amount_irr, o.amount_ypoint,
              o.payment_method, o.status, o.fulfillment_status,
              o.created_at, o.paid_at, o.fulfilled_at,
              c.name AS club_name, c.slug AS club_slug
         FROM public.club_shop_orders o
         JOIN public.clubs c ON c.id = o.club_id
        WHERE o.buyer_steam_id = $1::bigint
        ORDER BY o.created_at DESC
        LIMIT 100`,
      [steamId],
    );
  }

  public async markOrderFulfilled(
    clubId: string,
    user: User,
    orderId: string,
  ) {
    this.assertUuid(clubId);
    this.assertUuid(orderId);
    await this.requireManageShop(clubId, user);
    const updated = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.club_shop_orders
          SET fulfillment_status = 'done',
              fulfilled_at = COALESCE(fulfilled_at, now())
        WHERE id = $1::uuid AND club_id = $2::uuid AND kind = 'custom'
          AND status = 'paid'
      RETURNING id::text`,
      [orderId, clubId],
    );
    if (!updated.length) {
      throw new NotFoundException("Order not found");
    }
    return { success: true };
  }
}
