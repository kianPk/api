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

  public async getPlayers(steamIds: string[]): Promise<RankView[]> {
    const ids = [
      ...new Set(
        steamIds
          .map((id) => String(id || "").match(/\b(7656119\d{10})\b/)?.[1])
          .filter(Boolean) as string[],
      ),
    ].slice(0, 64);
    if (!ids.length) return [];
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
        const view = this.decorate(row);
        results.push(view);
        if (serverId && /^[0-9a-f-]{36}$/i.test(serverId)) {
          await this.postgres.query(
            `INSERT INTO public_server_rank_presence
               (server_id, steam_id, name, points, updated_at)
             VALUES ($1, $2::bigint, $3, $4, now())
             ON CONFLICT (server_id, steam_id) DO UPDATE SET
               name = COALESCE(NULLIF(EXCLUDED.name, ''), public_server_rank_presence.name),
               points = EXCLUDED.points,
               updated_at = now()`,
            [serverId, view.steam_id, view.name, view.points],
          );
        }
      }
    }
    return results;
  }

  public thresholds() {
    return SKILL_THRESHOLDS;
  }
}
