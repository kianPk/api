import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";

/** Competitive skill-group thresholds (1–18). Points map to TAB icons. */
const SKILL_THRESHOLDS: Array<{ points: number; skill: number; name: string }> =
  [
    { points: 0, skill: 1, name: "Silver I" },
    { points: 100, skill: 2, name: "Silver II" },
    { points: 250, skill: 3, name: "Silver III" },
    { points: 450, skill: 4, name: "Silver IV" },
    { points: 700, skill: 5, name: "Silver Elite" },
    { points: 1000, skill: 6, name: "Silver Elite Master" },
    { points: 1400, skill: 7, name: "Gold Nova I" },
    { points: 1900, skill: 8, name: "Gold Nova II" },
    { points: 2500, skill: 9, name: "Gold Nova III" },
    { points: 3200, skill: 10, name: "Gold Nova Master" },
    { points: 4000, skill: 11, name: "Master Guardian I" },
    { points: 5000, skill: 12, name: "Master Guardian II" },
    { points: 6200, skill: 13, name: "Master Guardian Elite" },
    { points: 7600, skill: 14, name: "Distinguished Master Guardian" },
    { points: 9200, skill: 15, name: "Legendary Eagle" },
    { points: 11000, skill: 16, name: "Legendary Eagle Master" },
    { points: 13000, skill: 17, name: "Supreme Master First Class" },
    { points: 15500, skill: 18, name: "The Global Elite" },
  ];

export type RankView = {
  steam_id: string;
  name: string | null;
  points: number;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  skill_group: number;
  rank_name: string;
};

@Injectable()
export class PublicRanksService {
  constructor(private readonly postgres: PostgresService) {}

  public static skillFromPoints(points: number): {
    skill_group: number;
    rank_name: string;
  } {
    const p = Math.max(0, Math.floor(Number(points) || 0));
    let current = SKILL_THRESHOLDS[0];
    for (const row of SKILL_THRESHOLDS) {
      if (p >= row.points) current = row;
      else break;
    }
    return { skill_group: current.skill, rank_name: current.name };
  }

  private decorate(row: {
    steam_id: string;
    name: string | null;
    points: number;
    kills: number;
    deaths: number;
    assists: number;
    headshots: number;
  }): RankView {
    const skill = PublicRanksService.skillFromPoints(row.points);
    return { ...row, ...skill };
  }

  /** Any game pod with a valid api_password — public dedicated included. */
  public async authenticateServer(
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

  public async getPlayers(
    steamIds: string[],
    serverId?: string | null,
  ): Promise<RankView[]> {
    const ids = [
      ...new Set(
        steamIds
          .map((id) => String(id || "").match(/\b(7656119\d{10})\b/)?.[1])
          .filter(Boolean) as string[],
      ),
    ].slice(0, 64);
    if (!ids.length) return [];

    // Per-server ladder: TAB / !rank on a box use only points earned on that box.
    if (serverId && /^[0-9a-f-]{36}$/i.test(serverId)) {
      const rows = await this.postgres.query<
        Array<{
          steam_id: string;
          name: string | null;
          points: number;
        }>
      >(
        `SELECT steam_id::text AS steam_id, name, points
         FROM public_server_rank_presence
         WHERE server_id = $1 AND steam_id = ANY($2::bigint[])`,
        [serverId, ids],
      );
      const byId = new Map(rows.map((r) => [r.steam_id, r]));
      return ids.map((id) => {
        const row = byId.get(id);
        return this.decorate({
          steam_id: id,
          name: row?.name ?? null,
          points: row?.points ?? 0,
          kills: 0,
          deaths: 0,
          assists: 0,
          headshots: 0,
        });
      });
    }

    const rows = await this.postgres.query<
      Array<{
        steam_id: string;
        name: string | null;
        points: number;
        kills: number;
        deaths: number;
        assists: number;
        headshots: number;
      }>
    >(
      `SELECT steam_id::text AS steam_id, name, points, kills, deaths, assists, headshots
       FROM public_server_ranks
       WHERE steam_id = ANY($1::bigint[])`,
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.steam_id, this.decorate(r)]));
    return ids.map(
      (id) =>
        byId.get(id) ||
        this.decorate({
          steam_id: id,
          name: null,
          points: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
          headshots: 0,
        }),
    );
  }

  /** Accumulate points earned on one public box (independent ladders). */
  public async applyServerDelta(
    serverId: string,
    steamId: string,
    name: string | null,
    deltaPoints: number,
  ): Promise<number> {
    if (!/^[0-9a-f-]{36}$/i.test(serverId) || !/^\d{17}$/.test(steamId)) {
      return 0;
    }
    const [row] = await this.postgres.query<Array<{ points: number }>>(
      `INSERT INTO public_server_rank_presence
         (server_id, steam_id, name, points, updated_at)
       VALUES ($1, $2::bigint, $3, GREATEST(0, $4::int), now())
       ON CONFLICT (server_id, steam_id) DO UPDATE SET
         name = COALESCE(NULLIF(EXCLUDED.name, ''), public_server_rank_presence.name),
         points = GREATEST(0, public_server_rank_presence.points + $4::int),
         updated_at = now()
       RETURNING points`,
      [serverId, steamId, name, Math.trunc(deltaPoints || 0)],
    );
    return row?.points ?? 0;
  }

  public async serverLeaderboard(
    serverId: string,
    limit = 10,
  ): Promise<RankView[]> {
    if (!/^[0-9a-f-]{36}$/i.test(serverId || "")) return [];
    const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 10)));
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
      [serverId, n],
    );
    return rows.map((r) =>
      this.decorate({
        steam_id: r.steam_id,
        name: r.name,
        points: r.points,
        kills: 0,
        deaths: 0,
        assists: 0,
        headshots: 0,
      }),
    );
  }

  /** @deprecated Prefer applyServerDelta — kept for callers that set absolute points. */
  public async touchPresence(
    serverId: string | null | undefined,
    players: Array<{ steam_id: string; name: string | null; points: number }>,
  ): Promise<void> {
    if (!serverId || !/^[0-9a-f-]{36}$/i.test(serverId) || !players.length) {
      return;
    }
    for (const p of players) {
      if (!/^\d{17}$/.test(p.steam_id)) continue;
      if (Math.max(0, Math.floor(p.points || 0)) <= 0) continue;
      await this.postgres.query(
        `INSERT INTO public_server_rank_presence
           (server_id, steam_id, name, points, updated_at)
         VALUES ($1, $2::bigint, $3, $4, now())
         ON CONFLICT (server_id, steam_id) DO UPDATE SET
           name = COALESCE(NULLIF(EXCLUDED.name, ''), public_server_rank_presence.name),
           points = EXCLUDED.points,
           updated_at = now()`,
        [serverId, p.steam_id, p.name, Math.max(0, Math.floor(p.points || 0))],
      );
    }
  }

  public async leaderboard(limit = 10): Promise<RankView[]> {
    const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 10)));
    const rows = await this.postgres.query<
      Array<{
        steam_id: string;
        name: string | null;
        points: number;
        kills: number;
        deaths: number;
        assists: number;
        headshots: number;
      }>
    >(
      `SELECT steam_id::text AS steam_id, name, points, kills, deaths, assists, headshots
       FROM public_server_ranks
       ORDER BY points DESC, updated_at ASC
       LIMIT $1`,
      [n],
    );
    return rows.map((r) => this.decorate(r));
  }

  public async applyDeltas(
    events: Array<{
      steam_id?: string;
      name?: string;
      delta_points?: number;
      kills?: number;
      deaths?: number;
      assists?: number;
      headshots?: number;
    }>,
    serverId?: string | null,
  ): Promise<RankView[]> {
    const cleaned = (events || [])
      .map((e) => {
        const steamId = String(e?.steam_id || "").match(
          /\b(7656119\d{10})\b/,
        )?.[1];
        if (!steamId) return null;
        return {
          steam_id: steamId,
          name: String(e?.name || "").slice(0, 64) || null,
          delta_points: Math.trunc(Number(e?.delta_points) || 0),
          kills: Math.max(0, Math.trunc(Number(e?.kills) || 0)),
          deaths: Math.max(0, Math.trunc(Number(e?.deaths) || 0)),
          assists: Math.max(0, Math.trunc(Number(e?.assists) || 0)),
          headshots: Math.max(0, Math.trunc(Number(e?.headshots) || 0)),
        };
      })
      .filter(Boolean) as Array<{
      steam_id: string;
      name: string | null;
      delta_points: number;
      kills: number;
      deaths: number;
      assists: number;
      headshots: number;
    }>;

    if (!cleaned.length) {
      throw new BadRequestException("No valid rank events");
    }
    if (cleaned.length > 64) {
      throw new BadRequestException("Too many events");
    }

    const results: RankView[] = [];
    for (const e of cleaned) {
      const [row] = await this.postgres.query<
        Array<{
          steam_id: string;
          name: string | null;
          points: number;
          kills: number;
          deaths: number;
          assists: number;
          headshots: number;
        }>
      >(
        `INSERT INTO public_server_ranks
           (steam_id, name, points, kills, deaths, assists, headshots, updated_at)
         VALUES ($1::bigint, $2, GREATEST(0, $3::int), $4, $5, $6, $7, now())
         ON CONFLICT (steam_id) DO UPDATE SET
           name = COALESCE(NULLIF(EXCLUDED.name, ''), public_server_ranks.name),
           points = GREATEST(0, public_server_ranks.points + $3::int),
           kills = public_server_ranks.kills + EXCLUDED.kills,
           deaths = public_server_ranks.deaths + EXCLUDED.deaths,
           assists = public_server_ranks.assists + EXCLUDED.assists,
           headshots = public_server_ranks.headshots + EXCLUDED.headshots,
           updated_at = now()
         RETURNING steam_id::text AS steam_id, name, points, kills, deaths, assists, headshots`,
        [
          e.steam_id,
          e.name,
          e.delta_points,
          e.kills,
          e.deaths,
          e.assists,
          e.headshots,
        ],
      );
      if (row) {
        // Prefer the per-server total so TAB / !rank stay independent per box.
        if (serverId && /^[0-9a-f-]{36}$/i.test(serverId)) {
          const serverPoints = await this.applyServerDelta(
            serverId,
            e.steam_id,
            e.name,
            e.delta_points,
          );
          results.push(
            this.decorate({
              ...row,
              points: serverPoints,
            }),
          );
        } else {
          results.push(this.decorate(row));
        }
      }
    }
    return results;
  }

  public thresholds() {
    return SKILL_THRESHOLDS;
  }

  /** Absolute points for one player on one public box (owner / admin). */
  public async setServerPoints(
    serverId: string,
    steamId: string,
    points: number,
    name?: string | null,
  ): Promise<RankView> {
    if (!/^[0-9a-f-]{36}$/i.test(serverId || "")) {
      throw new BadRequestException("Invalid server");
    }
    const sid = String(steamId || "").match(/\b(7656119\d{10})\b/)?.[1];
    if (!sid) {
      throw new BadRequestException("Valid steam_id required");
    }
    const pts = Math.max(0, Math.min(1_000_000, Math.floor(Number(points) || 0)));
    const [row] = await this.postgres.query<
      Array<{ steam_id: string; name: string | null; points: number }>
    >(
      `INSERT INTO public_server_rank_presence
         (server_id, steam_id, name, points, updated_at)
       VALUES ($1, $2::bigint, $3, $4, now())
       ON CONFLICT (server_id, steam_id) DO UPDATE SET
         name = COALESCE(NULLIF(EXCLUDED.name, ''), public_server_rank_presence.name),
         points = EXCLUDED.points,
         updated_at = now()
       RETURNING steam_id::text AS steam_id, name, points`,
      [serverId, sid, name?.slice(0, 64) || null, pts],
    );
    return this.decorate({
      steam_id: row?.steam_id ?? sid,
      name: row?.name ?? name ?? null,
      points: row?.points ?? pts,
      kills: 0,
      deaths: 0,
      assists: 0,
      headshots: 0,
    });
  }

  /** Map skill group 1–18 → minimum points for that badge. */
  public pointsForSkillGroup(skillGroup: number): number {
    const skill = Math.max(1, Math.min(18, Math.floor(Number(skillGroup) || 1)));
    const row = SKILL_THRESHOLDS.find((t) => t.skill === skill);
    return row?.points ?? 0;
  }
}
