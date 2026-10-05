import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { User } from "../auth/types/User";
import { PostgresService } from "../postgres/postgres.service";
import { PublicRanksService } from "./public-ranks.service";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";

type Profile = {
  show_vips: boolean;
  show_ranks: boolean;
  show_bans: boolean;
};

const DEFAULT_PROFILE: Profile = {
  show_vips: true,
  show_ranks: true,
  show_bans: true,
};

@Injectable()
export class PublicServerDetailsService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly ranks: PublicRanksService,
  ) {}

  private async requireServer(serverId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(serverId || "")) {
      throw new BadRequestException("Invalid server");
    }
    const [row] = await this.postgres.query<
      Array<{ id: string; label: string | null }>
    >(`SELECT id, label FROM servers WHERE id = $1`, [serverId]);
    if (!row) throw new NotFoundException("Server not found");
    return row;
  }

  private async getProfile(serverId: string): Promise<Profile> {
    const [row] = await this.postgres.query<Array<Profile>>(
      `SELECT show_vips, show_ranks, show_bans
       FROM server_public_profile WHERE server_id = $1`,
      [serverId],
    );
    return row || { ...DEFAULT_PROFILE };
  }

  private async canManage(serverId: string, user?: User): Promise<boolean> {
    if (!user?.steam_id) return false;
    if (user.role === "administrator") return true;
    const [owned] = await this.postgres.query<Array<{ ok: number }>>(
      `SELECT 1 AS ok FROM hosted_servers
       WHERE (server_id = $1 OR pending_server_id = $1)
         AND owner_steam_id = $2::bigint
         AND status <> 'deleted'
       LIMIT 1`,
      [serverId, user.steam_id],
    );
    return !!owned;
  }

  public async getDetails(serverId: string, user?: User) {
    const server = await this.requireServer(serverId);
    const settings = await this.getProfile(serverId);
    const manage = await this.canManage(serverId, user);

    const payload: Record<string, unknown> = {
      server_id: server.id,
      label: server.label,
      settings,
      can_manage: manage,
    };

    if (settings.show_vips || manage) {
      payload.vips = await this.listVips(serverId);
    }
    if (settings.show_ranks || manage) {
      payload.ranks = await this.listServerRanks(serverId, 100);
    }
    if (settings.show_bans || manage) {
      payload.bans = await this.listBans(serverId);
    }

    return payload;
  }

  public async updateSettings(
    serverId: string,
    user: User | undefined,
    body: Partial<Profile>,
  ) {
    if (!(await this.canManage(serverId, user))) {
      throw new ForbiddenException("Not allowed");
    }
    await this.requireServer(serverId);
    const current = await this.getProfile(serverId);
    const next: Profile = {
      show_vips:
        typeof body.show_vips === "boolean" ? body.show_vips : current.show_vips,
      show_ranks:
        typeof body.show_ranks === "boolean"
          ? body.show_ranks
          : current.show_ranks,
      show_bans:
        typeof body.show_bans === "boolean" ? body.show_bans : current.show_bans,
    };
    await this.postgres.query(
      `INSERT INTO server_public_profile
         (server_id, show_vips, show_ranks, show_bans, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (server_id) DO UPDATE SET
         show_vips = EXCLUDED.show_vips,
         show_ranks = EXCLUDED.show_ranks,
         show_bans = EXCLUDED.show_bans,
         updated_at = now()`,
      [serverId, next.show_vips, next.show_ranks, next.show_bans],
    );
    return { settings: next, can_manage: true };
  }

  private async listVips(serverId: string) {
    return this.postgres.query<
      Array<{
        steam_id: string;
        expires_at: string | null;
        name: string | null;
        avatar_url: string | null;
      }>
    >(
      `SELECT g.steam_id::text AS steam_id, g.expires_at::text AS expires_at,
              p.name, p.avatar_url
       FROM store_vip_grants g
       LEFT JOIN players p ON p.steam_id = g.steam_id
       WHERE g.server_id = $1
         AND (g.expires_at IS NULL OR g.expires_at > now())
       ORDER BY g.expires_at ASC NULLS LAST`,
      [serverId],
    );
  }

  private async listServerRanks(serverId: string, limit: number) {
    // Per-server ladder only — points earned on this box, not the global total.
    const rows = await this.postgres.query<
      Array<{
        steam_id: string;
        name: string | null;
        points: number;
      }>
    >(
      `SELECT steam_id::text AS steam_id, name, points
       FROM public_server_rank_presence
       WHERE server_id = $1 AND points > 0
       ORDER BY points DESC, updated_at ASC
       LIMIT $2`,
      [serverId, Math.min(200, Math.max(1, limit))],
    );
    return rows.map((r) => ({
      ...r,
      ...PublicRanksService.skillFromPoints(r.points),
    }));
  }

  private async listBans(serverId: string) {
    const [hosted] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id FROM hosted_servers
       WHERE (server_id = $1 OR pending_server_id = $1) AND status <> 'deleted'
       ORDER BY created_at DESC LIMIT 1`,
      [serverId],
    );
    if (hosted) {
      return this.postgres.query<
        Array<{
          steam_id: string;
          name: string | null;
          reason: string | null;
          expires_at: string | null;
        }>
      >(
        `SELECT steam_id::text AS steam_id, name, reason, expires_at::text AS expires_at
         FROM hosted_server_bans
         WHERE hosted_server_id = $1
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY created_at DESC`,
        [hosted.id],
      );
    }
    return this.postgres.query<
      Array<{
        steam_id: string;
        name: string | null;
        reason: string | null;
        expires_at: string | null;
      }>
    >(
      `SELECT steam_id::text AS steam_id, name, reason, expires_at::text AS expires_at
       FROM server_bans
       WHERE server_id = $1
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY updated_at DESC`,
      [serverId],
    );
  }

  /** Game pod replaces the ban list for a public (non-hosted) server. */
  public async pluginSyncBans(
    authorization: unknown,
    body: {
      server_id?: string;
      bans?: Array<{
        steam_id?: string;
        name?: string;
        reason?: string;
        expires_at?: string | null;
      }>;
    },
  ) {
    const serverId = await this.authenticateServer(
      String(body?.server_id || ""),
      authorization,
    );
    const bans = Array.isArray(body?.bans) ? body.bans : [];
    if (bans.length > 500) {
      throw new BadRequestException("Too many bans");
    }

    await this.postgres.query(`DELETE FROM server_bans WHERE server_id = $1`, [
      serverId,
    ]);

    for (const ban of bans) {
      const steamId = String(ban?.steam_id || "").match(
        /\b(7656119\d{10})\b/,
      )?.[1];
      if (!steamId) continue;
      let expires: string | null = null;
      if (ban.expires_at) {
        const d = new Date(ban.expires_at);
        if (!Number.isNaN(d.getTime())) expires = d.toISOString();
      }
      await this.postgres.query(
        `INSERT INTO server_bans (server_id, steam_id, name, reason, expires_at, updated_at)
         VALUES ($1, $2::bigint, $3, $4, $5::timestamptz, now())
         ON CONFLICT (server_id, steam_id) DO UPDATE SET
           name = EXCLUDED.name,
           reason = EXCLUDED.reason,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()`,
        [
          serverId,
          steamId,
          String(ban.name || "").slice(0, 64) || null,
          String(ban.reason || "").slice(0, 200) || null,
          expires,
        ],
      );
    }
    return { success: true, count: bans.length };
  }

  private async authenticateServer(
    serverId: string,
    authorization: unknown,
  ): Promise<string> {
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
    return serverId;
  }
}
