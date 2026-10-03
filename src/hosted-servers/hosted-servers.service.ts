import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes, randomUUID } from "crypto";
import { PostgresService } from "../postgres/postgres.service";
import { HasuraService } from "../hasura/hasura.service";
import { RconService } from "../rcon/rcon.service";
import { NotificationsService } from "../notifications/notifications.service";
import { DedicatedServersService } from "../dedicated-servers/dedicated-servers.service";
import { SteamConfig } from "../configs/types/SteamConfig";
import { User } from "../auth/types/User";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";
import {
  e_notification_types_enum,
  e_server_types_enum,
  servers_insert_input,
} from "../../generated/schema";

export const HOSTED_SERVER_TYPES = [
  "Casual",
  "Competitive",
  "Wingman",
  "Deathmatch",
  "ArmsRace",
  "Retake",
  "Practice",
] as const;

export type HostedServerType = (typeof HOSTED_SERVER_TYPES)[number];

const HOSTED_STATUSES_HOLDING_SLOT = [
  "provisioning",
  "active",
  "expired",
  "suspended",
];

// The panel drives RCON with this password and the pod's identity with the
// token; an owner changing either would cut the server off from the panel.
const BLOCKED_RCON_COMMANDS =
  /^\s*(rcon_password|sv_setsteamaccount|hostport|hostip|ip|sv_lan|net_public_adr|tv_port|sv_hibernate_when_empty)\b/i;

const MAX_HOSTED_ADMINS = 32;

type HostedSettings = {
  enabled: boolean;
  nodeId: string;
  maxActive: number;
  reserveMatchSlots: number;
  graceDays: number;
  gsltPool: string[];
  steamApiKey: string;
};

type HostedRow = {
  id: string;
  server_id: string | null;
  owner_steam_id: string;
  product_id: string | null;
  slots: number;
  label: string;
  status: string;
  status_detail: string | null;
  expires_at: string;
  gslt_steam_id: string | null;
  reminded_at: string | null;
  created_at: string;
};

type OrderRow = {
  id: string;
  buyer_steam_id: string;
  status: string;
  hosted_kind: string | null;
  hosted_server_id: string | null;
  hosted_type: string | null;
  hosted_label: string | null;
  hosted_fulfilled_at: string | null;
  product_id: string;
  product_title: string;
  hosted_slots: number | null;
  vip_duration: string | null;
};

@Injectable()
export class HostedServersService {
  private readonly envSteamApiKey: string;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly postgres: PostgresService,
    private readonly hasura: HasuraService,
    private readonly rcon: RconService,
    private readonly notifications: NotificationsService,
    private readonly dedicatedServers: DedicatedServersService,
  ) {
    this.envSteamApiKey =
      this.config.get<SteamConfig>("steam")?.steamApiKey || "";
  }

  public static isHostedType(type: string): type is HostedServerType {
    return (HOSTED_SERVER_TYPES as readonly string[]).includes(type);
  }

  public static durationMs(duration: string): number {
    const m = (duration || "")
      .trim()
      .toLowerCase()
      .match(/^(\d+)\s*(h|hr|hrs|d|day|days|w|week|weeks|mo|month|months)$/);
    if (!m) {
      return 30 * 86_400_000;
    }
    const n = Number(m[1]);
    const unit = m[2];
    if (/^(h|hr|hrs)$/.test(unit)) return n * 3_600_000;
    if (/^(d|day|days)$/.test(unit)) return n * 86_400_000;
    if (/^(w|week|weeks)$/.test(unit)) return n * 7 * 86_400_000;
    return n * 30 * 86_400_000;
  }

  public async getSettings(): Promise<HostedSettings> {
    const rows = await this.postgres.query<
      Array<{ name: string; value: string }>
    >(`SELECT name, value FROM settings WHERE name LIKE 'hosted_servers.%'`);
    const map = Object.fromEntries(
      rows.map((r) => [r.name.replace("hosted_servers.", ""), r.value ?? ""]),
    );
    const int = (value: string | undefined, fallback: number) => {
      const n = Number.parseInt(value ?? "", 10);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
      enabled: (map.enabled ?? "true") === "true",
      nodeId: map.node_id || "",
      maxActive: int(map.max_active, 3),
      reserveMatchSlots: int(map.reserve_match_slots, 2),
      graceDays: int(map.grace_days, 3),
      gsltPool: (map.gslt_pool || "")
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter((t) => /^[A-F0-9]{32}$/i.test(t)),
      steamApiKey: map.steam_api_key || this.envSteamApiKey,
    };
  }

  public async updateSettings(input: {
    enabled?: boolean;
    max_active?: number;
    reserve_match_slots?: number;
    grace_days?: number;
    gslt_pool?: string;
    steam_api_key?: string;
  }) {
    const entries: Array<[string, string]> = [];
    if (typeof input.enabled === "boolean") {
      entries.push(["enabled", input.enabled ? "true" : "false"]);
    }
    for (const key of [
      "max_active",
      "reserve_match_slots",
      "grace_days",
    ] as const) {
      const value = input[key];
      if (value !== undefined && value !== null) {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 100) {
          throw new BadRequestException(`${key} must be 0..100`);
        }
        entries.push([key, String(n)]);
      }
    }
    if (typeof input.gslt_pool === "string") {
      entries.push(["gslt_pool", input.gslt_pool.trim()]);
    }
    if (typeof input.steam_api_key === "string") {
      entries.push(["steam_api_key", input.steam_api_key.trim()]);
    }
    for (const [key, value] of entries) {
      await this.postgres.query(
        `INSERT INTO settings (name, value) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
        [`hosted_servers.${key}`, value],
      );
    }
    return this.getAdminSettings();
  }

  public async getAdminSettings() {
    const settings = await this.getSettings();
    return {
      enabled: settings.enabled,
      node_id: settings.nodeId,
      max_active: settings.maxActive,
      reserve_match_slots: settings.reserveMatchSlots,
      grace_days: settings.graceDays,
      gslt_pool_size: settings.gsltPool.length,
      steam_api_key_set: Boolean(settings.steamApiKey),
    };
  }

  public async getAvailability() {
    const settings = await this.getSettings();
    const [{ used }] = await this.postgres.query<Array<{ used: number }>>(
      `SELECT count(*)::int AS used FROM hosted_servers
       WHERE status = ANY($1::text[])`,
      [HOSTED_STATUSES_HOLDING_SLOT],
    );
    const freeNodeSlots = settings.nodeId
      ? await this.freeNodeSlots(settings.nodeId)
      : 0;
    const remaining = Math.max(
      0,
      Math.min(
        settings.maxActive - used,
        freeNodeSlots - settings.reserveMatchSlots,
      ),
    );
    return {
      enabled: settings.enabled && Boolean(settings.nodeId),
      remaining,
      available: settings.enabled && Boolean(settings.nodeId) && remaining > 0,
    };
  }

  public async listPlans() {
    return this.postgres.query<
      Array<{
        id: string;
        title: string;
        description: string;
        price_irr: number;
        price_ypoint: number | null;
        image_url: string | null;
        hosted_slots: number;
        duration: string;
      }>
    >(
      `SELECT id, title, description, price_irr, price_ypoint, image_url, hosted_slots,
              COALESCE(NULLIF(vip_duration, ''), '30d') AS duration
       FROM store_products
       WHERE active = true AND hosted_slots IS NOT NULL
       ORDER BY sort_order ASC, price_irr ASC`,
    );
  }

  public async getPublicOverview() {
    const [availability, plans] = await Promise.all([
      this.getAvailability(),
      this.listPlans(),
    ]);
    return { ...availability, plans, types: HOSTED_SERVER_TYPES };
  }

  /** Throws when a new server can't be sold right now. */
  public async assertCanSellNew() {
    const availability = await this.getAvailability();
    if (!availability.enabled) {
      throw new BadRequestException("Server sales are disabled");
    }
    if (!availability.available) {
      throw new BadRequestException(
        "No server capacity is available right now. Please try again later.",
      );
    }
  }

  public async assertCanRenew(hostedId: string, steamId: string) {
    const hosted = await this.getHosted(hostedId);
    if (!hosted || String(hosted.owner_steam_id) !== String(steamId)) {
      throw new NotFoundException("Server not found");
    }
    if (hosted.status === "failed" || hosted.status === "suspended") {
      throw new BadRequestException(`Server is ${hosted.status}`);
    }
    if (hosted.status === "deleted") {
      await this.assertCanSellNew();
    }
    return hosted;
  }

  /**
   * Idempotent: the hosted_fulfilled_at claim makes a second call (web webhook
   * forward + lifecycle sweep) a no-op, so a paid order never yields two servers.
   */
  public async fulfillOrder(orderId: string) {
    const [order] = await this.postgres.query<OrderRow[]>(
      `SELECT o.id, o.buyer_steam_id::text, o.status, o.hosted_kind,
              o.hosted_server_id, o.hosted_type, o.hosted_label,
              o.hosted_fulfilled_at, p.id AS product_id, p.title AS product_title,
              p.hosted_slots, p.vip_duration
       FROM store_orders o
       JOIN store_products p ON p.id = o.product_id
       WHERE o.id = $1`,
      [orderId],
    );
    if (
      !order ||
      order.status !== "paid" ||
      order.hosted_fulfilled_at ||
      !order.hosted_slots
    ) {
      return;
    }

    const claimed = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE store_orders SET hosted_fulfilled_at = now()
       WHERE id = $1 AND hosted_fulfilled_at IS NULL
       RETURNING id`,
      [orderId],
    );
    if (!claimed.length) {
      return;
    }

    const durationMs = HostedServersService.durationMs(
      order.vip_duration || "30d",
    );

    let hosted: HostedRow | null = null;
    if (order.hosted_kind === "renew" && order.hosted_server_id) {
      hosted = await this.getHosted(order.hosted_server_id);
      if (
        hosted &&
        String(hosted.owner_steam_id) !== String(order.buyer_steam_id)
      ) {
        hosted = null;
      }
    }

    try {
      if (hosted) {
        await this.renew(hosted, durationMs);
        return;
      }

      const type = HostedServersService.isHostedType(order.hosted_type || "")
        ? (order.hosted_type as HostedServerType)
        : "Casual";
      const label =
        this.cleanLabel(order.hosted_label) ||
        `${order.product_title}`.slice(0, 64);

      const [created] = await this.postgres.query<Array<{ id: string }>>(
        `INSERT INTO hosted_servers
          (owner_steam_id, product_id, slots, label, status, expires_at)
         VALUES ($1::bigint, $2::uuid, $3, $4, 'provisioning',
                 now() + ($5::double precision * interval '1 millisecond'))
         RETURNING id`,
        [
          order.buyer_steam_id,
          order.product_id,
          order.hosted_slots,
          label,
          durationMs,
        ],
      );
      await this.postgres.query(
        `UPDATE store_orders SET hosted_server_id = $2 WHERE id = $1`,
        [order.id, created.id],
      );

      await this.provision(created.id, type);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `hosted fulfillment failed order=${order.id}: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.notifyAdmins(
        "Hosted server fulfillment failed",
        `Order ${order.id} (${NotificationsService.escapeHtml(order.product_title)}) was paid but the server could not be set up: ${NotificationsService.escapeHtml(message.slice(0, 300))}`,
        order.id,
      );
    }
  }

  private async renew(hosted: HostedRow, durationMs: number) {
    const [updated] = await this.postgres.query<HostedRow[]>(
      `UPDATE hosted_servers
       SET expires_at = GREATEST(expires_at, now()) + ($2::double precision * interval '1 millisecond'),
           reminded_at = NULL,
           status = CASE WHEN status = 'expired' THEN 'active' ELSE status END,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [hosted.id, durationMs],
    );

    if (hosted.status === "deleted" || !hosted.server_id) {
      await this.provision(hosted.id, "Casual");
      return;
    }

    if (hosted.status === "expired") {
      await this.setServerEnabled(hosted.server_id, true);
    }

    await this.notifyOwner(
      updated.owner_steam_id,
      "HostedServerReady",
      "Server renewed",
      `Your server <b>${NotificationsService.escapeHtml(updated.label)}</b> was renewed until ${new Date(updated.expires_at).toISOString().slice(0, 10)}. <a href="/hosting/${updated.id}">Manage server</a>`,
      updated.id,
    );
  }

  private async provision(hostedId: string, type: HostedServerType) {
    const hosted = await this.getHosted(hostedId);
    if (!hosted) {
      throw new Error(`hosted server ${hostedId} not found`);
    }
    const settings = await this.getSettings();
    if (!settings.nodeId) {
      return this.failProvision(
        hosted,
        "No game node configured for hosted servers",
      );
    }
    if ((await this.freeNodeSlots(settings.nodeId)) < 1) {
      return this.failProvision(hosted, "No free port slot on the game node");
    }

    const gslt = await this.obtainGslt(hosted.id, settings);

    // The insert event builds the deployment straight away, so the token and
    // the hosted marker have to exist before the row does.
    const serverId = randomUUID();
    await this.postgres.query(
      `UPDATE hosted_servers SET pending_server_id = $2 WHERE id = $1`,
      [hosted.id, serverId],
    );

    await this.hasura.mutation({
      insert_servers_one: {
        __args: {
          object: {
            id: serverId,
            enabled: true,
            is_dedicated: true,
            type: type as e_server_types_enum,
            label: hosted.label || "Server",
            game: "cs2",
            region: "",
            game_server_node_id: settings.nodeId,
            host: "127.0.0.1",
            port: 27015,
            tv_port: 27020,
            rcon_password: randomBytes(16).toString("hex"),
            max_players: hosted.slots,
            steam_account_token: gslt?.token || null,
          } as servers_insert_input,
        },
        id: true,
      },
    });

    await this.postgres.query(
      `UPDATE hosted_servers
       SET server_id = $2, pending_server_id = NULL, status = 'active',
           gslt_steam_id = $3, status_detail = $4, updated_at = now()
       WHERE id = $1`,
      [
        hosted.id,
        serverId,
        gslt?.steamId || null,
        gslt ? null : "Waiting for a Steam game server token",
      ],
    );

    if (!gslt) {
      await this.notifyAdmins(
        "Hosted server needs a GSLT",
        `Hosted server <b>${NotificationsService.escapeHtml(hosted.label)}</b> (${serverId}) was created without a Steam game server token, so it only accepts LAN connections. Set servers.steam_account_token or add tokens to hosted_servers.gslt_pool.`,
        hosted.id,
      );
    }

    await this.notifyOwner(
      hosted.owner_steam_id,
      "HostedServerReady",
      "Your server is ready",
      `Your server <b>${NotificationsService.escapeHtml(hosted.label)}</b> is being started. <a href="/hosting/${hosted.id}">Manage server</a>`,
      hosted.id,
    );
  }

  private async failProvision(hosted: HostedRow, reason: string) {
    await this.postgres.query(
      `UPDATE hosted_servers SET status = 'failed', status_detail = $2, updated_at = now()
       WHERE id = $1`,
      [hosted.id, reason],
    );
    await this.notifyAdmins(
      "Hosted server provisioning failed",
      `Hosted server ${hosted.id} for ${hosted.owner_steam_id} failed: ${NotificationsService.escapeHtml(reason)}. The buyer paid; extend capacity and retry, or refund.`,
      hosted.id,
    );
    await this.notifyOwner(
      hosted.owner_steam_id,
      "HostedServerFailed",
      "Server setup failed",
      `We could not set up your server right now. Support has been notified and will contact you. <a href="/hosting/${hosted.id}">Details</a>`,
      hosted.id,
    );
  }

  public async retryProvision(hostedId: string) {
    const hosted = await this.getHosted(hostedId);
    if (!hosted) {
      throw new NotFoundException("Server not found");
    }
    if (hosted.status !== "failed" && hosted.status !== "deleted") {
      throw new BadRequestException(`Server is ${hosted.status}`);
    }
    await this.postgres.query(
      `UPDATE hosted_servers SET status = 'provisioning', status_detail = NULL, updated_at = now()
       WHERE id = $1`,
      [hosted.id],
    );
    await this.provision(hosted.id, "Casual");
    return this.getHostedView(hosted.id);
  }

  private async obtainGslt(
    hostedId: string,
    settings: HostedSettings,
  ): Promise<{ token: string; steamId: string | null } | null> {
    if (settings.steamApiKey) {
      try {
        const body = new URLSearchParams({
          key: settings.steamApiKey,
          appid: "730",
          memo: `hosted ${hostedId}`.slice(0, 32),
        });
        const res = await fetch(
          "https://api.steampowered.com/IGameServersService/CreateAccount/v1/",
          { method: "POST", body },
        );
        const data = (await res.json().catch(() => ({}))) as {
          response?: { steamid?: string; login_token?: string };
        };
        const token = data.response?.login_token;
        if (res.ok && token) {
          return { token, steamId: data.response?.steamid || null };
        }
        this.logger.warn(
          `GSLT CreateAccount failed status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`,
        );
      } catch (error) {
        this.logger.warn(
          `GSLT CreateAccount error: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (settings.gsltPool.length) {
      const used = await this.postgres.query<Array<{ token: string }>>(
        `SELECT steam_account_token AS token FROM servers
         WHERE steam_account_token = ANY($1::text[])`,
        [settings.gsltPool],
      );
      const usedSet = new Set(used.map((u) => u.token));
      const free = settings.gsltPool.find((t) => !usedSet.has(t));
      if (free) {
        return { token: free, steamId: null };
      }
    }

    return null;
  }

  private async deleteGslt(steamId: string) {
    const settings = await this.getSettings();
    if (!settings.steamApiKey) return;
    try {
      await fetch(
        "https://api.steampowered.com/IGameServersService/DeleteAccount/v1/",
        {
          method: "POST",
          body: new URLSearchParams({
            key: settings.steamApiKey,
            steamid: steamId,
          }),
        },
      );
    } catch (error) {
      this.logger.warn(
        `GSLT DeleteAccount error: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  public async processLifecycle() {
    const unfulfilled = await this.postgres.query<Array<{ id: string }>>(
      `SELECT o.id FROM store_orders o
       JOIN store_products p ON p.id = o.product_id
       WHERE o.status = 'paid'
         AND o.hosted_fulfilled_at IS NULL
         AND p.hosted_slots IS NOT NULL
         AND o.paid_at > now() - interval '7 days'
       ORDER BY o.paid_at ASC
       LIMIT 20`,
    );
    for (const { id } of unfulfilled) {
      await this.fulfillOrder(id);
    }

    const expiring = await this.postgres.query<HostedRow[]>(
      `UPDATE hosted_servers SET reminded_at = now()
       WHERE status = 'active'
         AND reminded_at IS NULL
         AND expires_at > now()
         AND expires_at < now() + interval '24 hours'
       RETURNING *`,
    );
    for (const hosted of expiring) {
      await this.notifyOwner(
        hosted.owner_steam_id,
        "HostedServerExpiring",
        "Server expires soon",
        `Your server <b>${NotificationsService.escapeHtml(hosted.label)}</b> expires in less than 24 hours. <a href="/hosting/${hosted.id}">Renew now</a>`,
        hosted.id,
      );
    }

    const expired = await this.postgres.query<HostedRow[]>(
      `UPDATE hosted_servers SET status = 'expired', updated_at = now()
       WHERE status = 'active' AND expires_at <= now()
       RETURNING *`,
    );
    const { graceDays } = await this.getSettings();
    for (const hosted of expired) {
      if (hosted.server_id) {
        await this.setServerEnabled(hosted.server_id, false);
      }
      await this.notifyOwner(
        hosted.owner_steam_id,
        "HostedServerExpired",
        "Server expired",
        `Your server <b>${NotificationsService.escapeHtml(hosted.label)}</b> expired and was stopped. Renew within ${graceDays} days to keep it. <a href="/hosting/${hosted.id}">Renew</a>`,
        hosted.id,
      );
    }

    const stale = await this.postgres.query<HostedRow[]>(
      `SELECT * FROM hosted_servers
       WHERE status = 'expired'
         AND expires_at <= now() - ($1::int * interval '1 day')`,
      [graceDays],
    );
    for (const hosted of stale) {
      await this.destroy(hosted);
    }
  }

  private async destroy(hosted: HostedRow) {
    if (hosted.server_id) {
      try {
        await this.hasura.mutation({
          delete_servers_by_pk: {
            __args: { id: hosted.server_id },
            id: true,
          },
        });
      } catch (error) {
        this.logger.error(
          `hosted destroy: delete server ${hosted.server_id} failed`,
          error instanceof Error ? error.stack : error,
        );
        return;
      }
    }
    if (hosted.gslt_steam_id) {
      await this.deleteGslt(hosted.gslt_steam_id);
    }
    await this.postgres.query(
      `UPDATE hosted_servers
       SET status = 'deleted', server_id = NULL, gslt_steam_id = NULL, updated_at = now()
       WHERE id = $1`,
      [hosted.id],
    );
  }

  public async getHosted(id: string): Promise<HostedRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id || "")) {
      return null;
    }
    const [row] = await this.postgres.query<HostedRow[]>(
      `SELECT id, server_id, owner_steam_id::text, product_id, slots, label,
              status, status_detail, expires_at, gslt_steam_id, reminded_at,
              created_at
       FROM hosted_servers WHERE id = $1`,
      [id],
    );
    return row ?? null;
  }

  public async requireAccess(id: string, user: User): Promise<HostedRow> {
    const hosted = await this.getHosted(id);
    if (!hosted) {
      throw new NotFoundException("Server not found");
    }
    if (
      user.role !== "administrator" &&
      String(hosted.owner_steam_id) !== String(user.steam_id)
    ) {
      throw new ForbiddenException("Not your server");
    }
    return hosted;
  }

  private requireRunnable(hosted: HostedRow): string {
    if (hosted.status !== "active" || !hosted.server_id) {
      throw new BadRequestException(`Server is ${hosted.status}`);
    }
    return hosted.server_id;
  }

  public async listForOwner(steamId: string) {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id FROM hosted_servers
       WHERE owner_steam_id = $1::bigint AND status <> 'deleted'
       ORDER BY created_at DESC`,
      [steamId],
    );
    return this.getHostedViews(rows.map((r) => r.id));
  }

  public async listAll() {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id FROM hosted_servers ORDER BY created_at DESC LIMIT 200`,
    );
    return this.getHostedViews(rows.map((r) => r.id));
  }

  public async getHostedView(id: string) {
    const [view] = await this.getHostedViews([id]);
    if (!view) {
      throw new NotFoundException("Server not found");
    }
    return view;
  }

  private async getHostedViews(ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.postgres.query<
      Array<
        HostedRow & {
          owner_name: string | null;
          server_label: string | null;
          host: string | null;
          port: number | null;
          type: string | null;
          connect_password: string | null;
          enabled: boolean | null;
          connected: boolean | null;
          max_players: number | null;
          has_gslt: boolean;
        }
      >
    >(
      `SELECT h.id, h.server_id, h.owner_steam_id::text, h.product_id, h.slots,
              h.label, h.status, h.status_detail, h.expires_at, h.created_at,
              pl.name AS owner_name,
              s.label AS server_label, s.host, s.port, s.type::text AS type,
              s.connect_password, s.enabled, s.connected, s.max_players,
              (s.steam_account_token IS NOT NULL AND s.steam_account_token <> '') AS has_gslt
       FROM hosted_servers h
       LEFT JOIN servers s ON s.id = h.server_id
       LEFT JOIN players pl ON pl.steam_id = h.owner_steam_id
       WHERE h.id = ANY($1::uuid[])
       ORDER BY h.created_at DESC`,
      [ids],
    );

    const stats = await this.dedicatedServers.getAllDedicatedServerStats();
    const statsById = new Map(stats.map((s) => [s.id, s]));

    return rows.map((row) => {
      const stat = row.server_id ? statsById.get(row.server_id) : undefined;
      return {
        id: row.id,
        server_id: row.server_id,
        owner_steam_id: row.owner_steam_id,
        owner_name: row.owner_name,
        label: row.server_label || row.label,
        slots: row.slots,
        status: row.status,
        status_detail: row.status_detail,
        expires_at: row.expires_at,
        created_at: row.created_at,
        product_id: row.product_id,
        type: row.type,
        host: row.host,
        port: row.port,
        connect_password: row.connect_password,
        enabled: row.enabled,
        connected: row.connected,
        has_gslt: row.has_gslt,
        players: stat?.players ?? null,
        map: stat?.map ?? null,
      };
    });
  }

  public async updateServerSettings(
    hosted: HostedRow,
    input: { label?: string; connect_password?: string | null; type?: string },
  ) {
    const serverId = this.requireRunnable(hosted);
    const set: Record<string, unknown> = {};

    if (input.label !== undefined) {
      const label = this.cleanLabel(input.label);
      if (!label) {
        throw new BadRequestException("Server name is required");
      }
      set.label = label;
    }
    if (input.connect_password !== undefined) {
      const password = (input.connect_password || "").trim();
      if (password && !/^[A-Za-z0-9_\-.]{1,32}$/.test(password)) {
        throw new BadRequestException(
          "Password may only contain letters, digits, _ - . (max 32)",
        );
      }
      set.connect_password = password || null;
    }
    if (input.type !== undefined) {
      if (!HostedServersService.isHostedType(input.type)) {
        throw new BadRequestException("Unsupported server mode");
      }
      set.type = input.type;
    }
    if (!Object.keys(set).length) {
      return this.getHostedView(hosted.id);
    }

    await this.hasura.mutation({
      update_servers_by_pk: {
        __args: {
          pk_columns: { id: serverId },
          _set: set,
        },
        id: true,
      },
    });
    if (set.label) {
      await this.postgres.query(
        `UPDATE hosted_servers SET label = $2, updated_at = now() WHERE id = $1`,
        [hosted.id, set.label as string],
      );
    }
    return this.getHostedView(hosted.id);
  }

  public async restart(hosted: HostedRow) {
    const serverId = this.requireRunnable(hosted);
    await this.dedicatedServers.restartDedicatedServer(serverId);
    return { success: true };
  }

  public async setPower(hosted: HostedRow, on: boolean) {
    const serverId = this.requireRunnable(hosted);
    await this.setServerEnabled(serverId, on);
    return this.getHostedView(hosted.id);
  }

  public async sendRcon(hosted: HostedRow, command: string) {
    const serverId = this.requireRunnable(hosted);
    const trimmed = (command || "").trim();
    if (!trimmed) {
      throw new BadRequestException("Command is required");
    }
    if (trimmed.length > 512) {
      throw new BadRequestException("Command is too long");
    }
    for (const part of trimmed.split(/[;\n]/)) {
      if (BLOCKED_RCON_COMMANDS.test(part)) {
        throw new BadRequestException("This command is not allowed");
      }
    }

    const rcon = await this.rcon.connect(serverId);
    if (!rcon) {
      throw new BadRequestException("Server is not reachable over RCON");
    }
    const result = await rcon.send(trimmed);
    return { result: String(result ?? "") };
  }

  public async listAdmins(hosted: HostedRow) {
    const admins = await this.postgres.query<
      Array<{
        steam_id: string;
        name: string | null;
        avatar_url: string | null;
        created_at: string;
      }>
    >(
      `SELECT a.steam_id::text AS steam_id, p.name, p.avatar_url, a.created_at
       FROM hosted_server_admins a
       LEFT JOIN players p ON p.steam_id = a.steam_id
       WHERE a.hosted_server_id = $1
       ORDER BY a.created_at ASC`,
      [hosted.id],
    );
    return { owner_steam_id: String(hosted.owner_steam_id), admins };
  }

  public async addAdmin(hosted: HostedRow, steamIdInput: unknown, by: User) {
    const steamId = HostedServersService.parseSteamId(steamIdInput);
    if (steamId === String(hosted.owner_steam_id)) {
      throw new BadRequestException("The owner is always an admin");
    }
    const [{ count }] = await this.postgres.query<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM hosted_server_admins WHERE hosted_server_id = $1`,
      [hosted.id],
    );
    if (count >= MAX_HOSTED_ADMINS) {
      throw new BadRequestException(
        `A server can have at most ${MAX_HOSTED_ADMINS} admins`,
      );
    }
    await this.postgres.query(
      `INSERT INTO hosted_server_admins (hosted_server_id, steam_id, added_by)
       VALUES ($1, $2::bigint, $3::bigint)
       ON CONFLICT DO NOTHING`,
      [hosted.id, steamId, by.steam_id],
    );
    await this.nudgeAdminPlugin(hosted);
    return this.listAdmins(hosted);
  }

  public async removeAdmin(hosted: HostedRow, steamIdInput: unknown) {
    const steamId = HostedServersService.parseSteamId(steamIdInput);
    await this.postgres.query(
      `DELETE FROM hosted_server_admins WHERE hosted_server_id = $1 AND steam_id = $2::bigint`,
      [hosted.id, steamId],
    );
    await this.nudgeAdminPlugin(hosted);
    return this.listAdmins(hosted);
  }

  public async listBans(hosted: HostedRow) {
    await this.postgres.query(
      `DELETE FROM hosted_server_bans
       WHERE hosted_server_id = $1 AND expires_at IS NOT NULL AND expires_at <= now()`,
      [hosted.id],
    );
    return this.postgres.query<
      Array<{
        steam_id: string;
        name: string;
        reason: string;
        banned_by_name: string;
        expires_at: string | null;
        created_at: string;
      }>
    >(
      `SELECT steam_id::text AS steam_id, name, reason, banned_by_name, expires_at, created_at
       FROM hosted_server_bans
       WHERE hosted_server_id = $1
       ORDER BY created_at DESC`,
      [hosted.id],
    );
  }

  public async removeBan(hosted: HostedRow, steamIdInput: unknown) {
    const steamId = HostedServersService.parseSteamId(steamIdInput);
    await this.postgres.query(
      `DELETE FROM hosted_server_bans WHERE hosted_server_id = $1 AND steam_id = $2::bigint`,
      [hosted.id, steamId],
    );
    await this.nudgeAdminPlugin(hosted);
    return this.listBans(hosted);
  }

  /**
   * Game-server side of the admin plugin. The pod proves its identity with
   * its own api_password, the same way the match and anticheat plugins do.
   */
  public async pluginState(serverId: string, authorization: unknown) {
    const hosted = await this.authenticatePluginServer(serverId, authorization);
    if (!hosted) {
      return { hosted: false, admins: [] as string[], bans: [] as never[] };
    }
    const [admins, bans] = await Promise.all([
      this.postgres.query<Array<{ steam_id: string }>>(
        `SELECT steam_id::text AS steam_id FROM hosted_server_admins WHERE hosted_server_id = $1`,
        [hosted.id],
      ),
      this.listBans(hosted),
    ]);
    return {
      hosted: true,
      owner_steam_id: String(hosted.owner_steam_id),
      admins: [
        String(hosted.owner_steam_id),
        ...admins.map((row) => row.steam_id),
      ],
      bans: bans.map((ban) => ({
        steam_id: ban.steam_id,
        reason: ban.reason,
        expires_at: ban.expires_at,
      })),
    };
  }

  public async pluginBan(
    authorization: unknown,
    body: {
      server_id?: string;
      steam_id?: string;
      name?: string;
      reason?: string;
      minutes?: number;
      admin_steam_id?: string;
      admin_name?: string;
    },
  ) {
    const hosted = await this.requirePluginAdmin(authorization, body);
    const steamId = HostedServersService.parseSteamId(body.steam_id);
    if (
      steamId === String(hosted.owner_steam_id) ||
      (await this.isHostedAdmin(hosted.id, steamId))
    ) {
      throw new BadRequestException("Admins cannot be banned");
    }
    const minutes = Math.max(0, Math.floor(Number(body.minutes) || 0));
    await this.postgres.query(
      `INSERT INTO hosted_server_bans
         (hosted_server_id, steam_id, name, reason, banned_by, banned_by_name, expires_at)
       VALUES ($1, $2::bigint, $3, $4, $5::bigint, $6,
               CASE WHEN $7::int > 0 THEN now() + ($7::int * interval '1 minute') END)
       ON CONFLICT (hosted_server_id, steam_id) DO UPDATE
       SET name = EXCLUDED.name,
           reason = EXCLUDED.reason,
           banned_by = EXCLUDED.banned_by,
           banned_by_name = EXCLUDED.banned_by_name,
           expires_at = EXCLUDED.expires_at,
           created_at = now()`,
      [
        hosted.id,
        steamId,
        String(body.name || "").slice(0, 64),
        String(body.reason || "").slice(0, 200),
        /^\d{17}$/.test(String(body.admin_steam_id || ""))
          ? String(body.admin_steam_id)
          : null,
        String(body.admin_name || "").slice(0, 64),
        Math.min(minutes, 60 * 24 * 365 * 10),
      ],
    );
    return { success: true };
  }

  public async pluginUnban(
    authorization: unknown,
    body: { server_id?: string; steam_id?: string; admin_steam_id?: string },
  ) {
    const hosted = await this.requirePluginAdmin(authorization, body);
    const steamId = HostedServersService.parseSteamId(body.steam_id);
    const removed = await this.postgres.query<Array<{ steam_id: string }>>(
      `DELETE FROM hosted_server_bans
       WHERE hosted_server_id = $1 AND steam_id = $2::bigint
       RETURNING steam_id::text AS steam_id`,
      [hosted.id, steamId],
    );
    return { success: true, removed: removed.length > 0 };
  }

  private async requirePluginAdmin(
    authorization: unknown,
    body: { server_id?: string; admin_steam_id?: string },
  ): Promise<HostedRow> {
    const hosted = await this.authenticatePluginServer(
      String(body?.server_id || ""),
      authorization,
    );
    if (!hosted) {
      throw new ForbiddenException("Not a hosted server");
    }
    // Empty admin = the server console, which only the owner reaches (panel RCON).
    const admin = String(body?.admin_steam_id || "");
    if (
      admin &&
      admin !== String(hosted.owner_steam_id) &&
      !(await this.isHostedAdmin(hosted.id, admin))
    ) {
      throw new ForbiddenException("Not an admin on this server");
    }
    return hosted;
  }

  private async isHostedAdmin(hostedId: string, steamId: string) {
    if (!/^\d{17}$/.test(steamId)) {
      return false;
    }
    const rows = await this.postgres.query<Array<{ ok: number }>>(
      `SELECT 1 AS ok FROM hosted_server_admins
       WHERE hosted_server_id = $1 AND steam_id = $2::bigint`,
      [hostedId, steamId],
    );
    return rows.length > 0;
  }

  private async authenticatePluginServer(
    serverId: string,
    authorization: unknown,
  ): Promise<HostedRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(serverId || "")) {
      throw new UnauthorizedException("Invalid server");
    }
    const token = String(authorization || "").replace(/^Bearer\s+/i, "");
    const [server] = await this.postgres.query<
      Array<{ api_password: string | null }>
    >(`SELECT api_password::text AS api_password FROM servers WHERE id = $1`, [
      serverId,
    ]);
    if (!server || !timingSafeStringEqual(server.api_password ?? "", token)) {
      throw new UnauthorizedException("Invalid server");
    }
    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id FROM hosted_servers
       WHERE (server_id = $1 OR pending_server_id = $1) AND status <> 'deleted'
       ORDER BY created_at DESC
       LIMIT 1`,
      [serverId],
    );
    return row ? this.getHosted(row.id) : null;
  }

  private async nudgeAdminPlugin(hosted: HostedRow) {
    if (hosted.status !== "active" || !hosted.server_id) {
      return;
    }
    try {
      const rcon = await this.rcon.connect(hosted.server_id);
      await rcon?.send("css_yadmin_reload");
    } catch {
      // The plugin polls on its own; this only makes the change instant.
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

  public async adminExtend(hostedId: string, days: number) {
    const n = Number(days);
    if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 3650) {
      throw new BadRequestException("days must be a non-zero number");
    }
    const hosted = await this.getHosted(hostedId);
    if (!hosted) {
      throw new NotFoundException("Server not found");
    }
    const [updated] = await this.postgres.query<HostedRow[]>(
      `UPDATE hosted_servers
       SET expires_at = expires_at + ($2::double precision * interval '1 day'),
           reminded_at = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [hosted.id, n],
    );
    const stillValid = new Date(updated.expires_at).getTime() > Date.now();
    if (hosted.status === "expired" && stillValid && hosted.server_id) {
      await this.postgres.query(
        `UPDATE hosted_servers SET status = 'active' WHERE id = $1`,
        [hosted.id],
      );
      await this.setServerEnabled(hosted.server_id, true);
    }
    return this.getHostedView(hostedId);
  }

  public async adminSuspend(hostedId: string, suspended: boolean) {
    const hosted = await this.getHosted(hostedId);
    if (!hosted) {
      throw new NotFoundException("Server not found");
    }
    if (suspended) {
      if (hosted.status !== "active" && hosted.status !== "expired") {
        throw new BadRequestException(`Server is ${hosted.status}`);
      }
      await this.postgres.query(
        `UPDATE hosted_servers SET status = 'suspended', updated_at = now() WHERE id = $1`,
        [hosted.id],
      );
      if (hosted.server_id) {
        await this.setServerEnabled(hosted.server_id, false);
      }
    } else {
      if (hosted.status !== "suspended") {
        throw new BadRequestException(`Server is ${hosted.status}`);
      }
      const active = new Date(hosted.expires_at).getTime() > Date.now();
      await this.postgres.query(
        `UPDATE hosted_servers SET status = $2, updated_at = now() WHERE id = $1`,
        [hosted.id, active ? "active" : "expired"],
      );
      if (active && hosted.server_id) {
        await this.setServerEnabled(hosted.server_id, true);
      }
    }
    return this.getHostedView(hostedId);
  }

  public async adminDelete(hostedId: string) {
    const hosted = await this.getHosted(hostedId);
    if (!hosted) {
      throw new NotFoundException("Server not found");
    }
    await this.destroy(hosted);
    return { success: true };
  }

  public async adminPurge(hostedId: string) {
    const hosted = await this.getHosted(hostedId);
    if (!hosted) {
      throw new NotFoundException("Server not found");
    }
    if (hosted.status !== "deleted") {
      await this.destroy(hosted);
      if ((await this.getHosted(hosted.id))?.status !== "deleted") {
        throw new BadRequestException("Could not remove the game server");
      }
    }
    await this.postgres.query(`DELETE FROM hosted_servers WHERE id = $1`, [
      hosted.id,
    ]);
    return { success: true };
  }

  public async listAdminPlans() {
    return this.postgres.query<
      Array<{
        id: string;
        title: string;
        price_irr: number;
        price_ypoint: number | null;
        hosted_slots: number;
        duration: string;
        active: boolean;
        servers: number;
      }>
    >(
      `SELECT p.id, p.title, p.price_irr, p.price_ypoint, p.hosted_slots, p.active,
              COALESCE(NULLIF(p.vip_duration, ''), '30d') AS duration,
              (SELECT count(*)::int FROM hosted_servers h
                WHERE h.product_id = p.id AND h.status <> 'deleted') AS servers
       FROM store_products p
       WHERE p.hosted_slots IS NOT NULL
       ORDER BY p.sort_order ASC, p.price_irr ASC`,
    );
  }

  public async adminSetPlanActive(productId: string, active: boolean) {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE store_products SET active = $2, updated_at = now()
       WHERE id = $1 AND hosted_slots IS NOT NULL
       RETURNING id`,
      [productId, active],
    );
    if (!rows.length) {
      throw new NotFoundException("Plan not found");
    }
    return { success: true };
  }

  public async adminDeletePlan(productId: string) {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `DELETE FROM store_products
       WHERE id = $1 AND hosted_slots IS NOT NULL
       RETURNING id`,
      [productId],
    );
    if (!rows.length) {
      throw new NotFoundException("Plan not found");
    }
    return { deleted: true };
  }

  public async adminSetGslt(hostedId: string, token: string) {
    const hosted = await this.getHosted(hostedId);
    if (!hosted?.server_id) {
      throw new NotFoundException("Server not found");
    }
    const clean = (token || "").trim();
    if (clean && !/^[A-F0-9]{32}$/i.test(clean)) {
      throw new BadRequestException("Invalid GSLT");
    }
    await this.hasura.mutation({
      update_servers_by_pk: {
        __args: {
          pk_columns: { id: hosted.server_id },
          _set: { steam_account_token: clean || null } as Record<
            string,
            unknown
          >,
        },
        id: true,
      },
    });
    await this.postgres.query(
      `UPDATE hosted_servers SET status_detail = $2, updated_at = now() WHERE id = $1`,
      [hosted.id, clean ? null : "Waiting for a Steam game server token"],
    );
    return this.getHostedView(hostedId);
  }

  private async setServerEnabled(serverId: string, enabled: boolean) {
    await this.hasura.mutation({
      update_servers_by_pk: {
        __args: {
          pk_columns: { id: serverId },
          _set: { enabled },
        },
        id: true,
      },
    });
  }

  private async freeNodeSlots(nodeId: string): Promise<number> {
    const [{ free }] = await this.postgres.query<Array<{ free: number }>>(
      `SELECT count(*)::int AS free FROM servers s
       WHERE s.game_server_node_id = $1
         AND s.is_dedicated = false
         AND s.enabled = true
         AND s.reserved_by_match_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM servers d
           WHERE d.game_server_node_id = s.game_server_node_id
             AND d.port = s.port
             AND d.is_dedicated = true
         )`,
      [nodeId],
    );
    return free;
  }

  private cleanLabel(label: string | null | undefined): string {
    return (label || "")
      .replace(/[\r\n"';\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 64);
  }

  private async notifyOwner(
    steamId: string,
    type: string,
    title: string,
    message: string,
    entityId: string,
  ) {
    try {
      await this.notifications.notifyPlayers(
        type as e_notification_types_enum,
        {
          title,
          message,
          role: "user",
          entity_id: entityId,
          steamIds: [String(steamId)],
        },
      );
    } catch (error) {
      this.logger.warn(
        `hosted notify failed type=${type} steam=${steamId}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async notifyAdmins(title: string, message: string, entityId: string) {
    try {
      await this.notifications.send(
        "HostedServerFailed" as e_notification_types_enum,
        {
          title,
          message: `${message} <a href="/hosting">Open hosted servers</a>`,
          role: "administrator",
          entity_id: entityId,
        },
      );
    } catch (error) {
      this.logger.warn(
        `hosted admin notify failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
