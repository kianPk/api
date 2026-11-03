import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";
import {
  SITE_LEVEL_FLOORS,
  siteLevelFromXp,
  siteXpDelta,
  siteXpForLevel,
  SiteXpInput,
} from "./site-xp";

export type SiteXpRow = {
  steam_id: string;
  xp: number;
  level: number;
};

export type SiteXpLeader = SiteXpRow & {
  name: string;
  avatar_url: string | null;
  custom_avatar_url: string | null;
  country: string | null;
};

@Injectable()
export class SiteXpService {
  private readonly recent = new Map<string, number>();
  private readonly deathStreak = new Map<string, number>();

  constructor(private readonly postgres: PostgresService) {}

  public async get(steamIds: string[]): Promise<SiteXpRow[]> {
    const ids = this.ids(steamIds);
    if (!ids.length) return [];
    const rows = await this.postgres.query<
      Array<{ steam_id: string; xp: number }>
    >(
      `SELECT steam_id::text AS steam_id, xp
         FROM public.player_site_xp
        WHERE steam_id = ANY($1::bigint[])`,
      [ids],
    );
    const byId = new Map(rows.map((row) => [row.steam_id, row.xp]));
    return ids.map((steamId) => {
      const xp = byId.get(steamId) ?? 0;
      return { steam_id: steamId, xp, level: siteLevelFromXp(xp) };
    });
  }

  public async top(limit: number): Promise<SiteXpLeader[]> {
    const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 10)));
    const rows = await this.postgres.query<
      Array<{
        steam_id: string;
        xp: number;
        name: string | null;
        avatar_url: string | null;
        custom_avatar_url: string | null;
        country: string | null;
      }>
    >(
      `SELECT p.steam_id::text AS steam_id,
              x.xp,
              p.name,
              p.avatar_url,
              p.custom_avatar_url,
              p.country
         FROM public.player_site_xp x
         JOIN public.players p ON p.steam_id = x.steam_id
        ORDER BY x.xp DESC, p.steam_id
        LIMIT $1`,
      [n],
    );
    return rows.map((row) => ({
      steam_id: row.steam_id,
      xp: row.xp,
      level: siteLevelFromXp(row.xp),
      name: row.name || "Player",
      avatar_url: row.avatar_url,
      custom_avatar_url: row.custom_avatar_url,
      country: row.country,
    }));
  }

  public async apply(input: SiteXpInput): Promise<SiteXpRow | null> {
    const [row] = await this.applyMany([input]);
    return row ?? null;
  }

  public async applyMany(
    events: SiteXpInput[],
    options?: { multipliers?: Map<string, number> },
  ): Promise<SiteXpRow[]> {
    const deltas = new Map<string, number>();
    for (const event of events.slice(0, 64)) {
      const steamId = this.ids([String(event.steam_id || "")])[0];
      if (!steamId || this.throttled(steamId, event)) continue;
      const kind = String(event.kind || "");
      if (kind === "kill" || kind === "round_win") {
        this.deathStreak.set(steamId, 0);
      }
      const scored =
        kind === "death"
          ? { ...event, streak: this.nextDeathStreak(steamId) }
          : event;
      let delta = siteXpDelta(scored);
      if (!delta) continue;
      // Gamenet / venue bonuses only amplify gains — never punishments.
      if (delta > 0) {
        const mult = Number(options?.multipliers?.get(steamId) || 1);
        if (Number.isFinite(mult) && mult > 1) {
          delta = Math.round(delta * Math.min(5, mult));
        }
      }
      deltas.set(steamId, (deltas.get(steamId) || 0) + delta);
    }
    const out: SiteXpRow[] = [];
    for (const [steamId, delta] of deltas) {
      out.push(await this.add(steamId, delta));
    }
    return out;
  }

  // FACEIT skill (1–10) should land the player at least at that site level
  // without pulling a higher site level back down.
  public async ensureMinLevel(
    steamId: string,
    level: number,
  ): Promise<SiteXpRow | null> {
    const id = this.ids([String(steamId || "")])[0];
    if (!id) return null;
    const target = Math.min(10, Math.max(1, Math.round(Number(level) || 1)));
    const xp = siteXpForLevel(target);
    const rows = await this.postgres.query<
      Array<{ steam_id: string; xp: number }>
    >(
      `INSERT INTO public.player_site_xp (steam_id, xp, updated_at)
       VALUES ($1::bigint, $2, now())
       ON CONFLICT (steam_id) DO UPDATE SET
         xp = GREATEST(player_site_xp.xp, EXCLUDED.xp),
         updated_at = now()
       RETURNING steam_id::text AS steam_id, xp`,
      [id, xp],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      steam_id: row.steam_id,
      xp: Number(row.xp),
      level: siteLevelFromXp(Number(row.xp)),
    };
  }

  /**
   * Raise site XP for every player whose stored FACEIT skill is higher than
   * their current site level. Uses DB columns only (no FACEIT API).
   */
  public async syncFromFaceitSkillLevels(): Promise<{
    checked: number;
    updated: number;
    withFaceit: number;
    behind: number;
    alreadyOk: number;
  }> {
    const caseArms = SITE_LEVEL_FLOORS.map(
      (xp, index) => `WHEN ${index + 1} THEN ${xp}`,
    ).join(" ");

    // Count first so a broken bump query cannot hide "we found Faceit rows".
    const [countRow] = await this.postgres.query<
      Array<{ with_faceit: number; behind: number; already_ok: number }>
    >(
      `SELECT
         COUNT(*)::int AS with_faceit,
         COUNT(*) FILTER (
           WHERE COALESCE(s.xp, 0) < CASE p.faceit_skill_level::int
             ${caseArms}
             ELSE 0
           END
         )::int AS behind,
         COUNT(*) FILTER (
           WHERE COALESCE(s.xp, 0) >= CASE p.faceit_skill_level::int
             ${caseArms}
             ELSE 0
           END
         )::int AS already_ok
         FROM public.players p
         LEFT JOIN public.player_site_xp s
           ON s.steam_id = p.steam_id::bigint
        WHERE p.faceit_skill_level IS NOT NULL
          AND p.faceit_skill_level::int BETWEEN 1 AND 10`,
    );
    const withFaceit = Number(countRow?.with_faceit ?? 0);
    const behind = Number(countRow?.behind ?? 0);
    const alreadyOk = Number(countRow?.already_ok ?? 0);

    const raised = await this.postgres.query<Array<{ steam_id: string }>>(
      `INSERT INTO public.player_site_xp (steam_id, xp, updated_at)
       SELECT p.steam_id::bigint,
              CASE p.faceit_skill_level::int
                ${caseArms}
                ELSE NULL
              END,
              now()
         FROM public.players p
         LEFT JOIN public.player_site_xp s
           ON s.steam_id = p.steam_id::bigint
        WHERE p.faceit_skill_level IS NOT NULL
          AND p.faceit_skill_level::int BETWEEN 1 AND 10
          AND (
            s.steam_id IS NULL
            OR s.xp < CASE p.faceit_skill_level::int
              ${caseArms}
              ELSE 0
            END
          )
       ON CONFLICT (steam_id) DO UPDATE SET
         xp = GREATEST(public.player_site_xp.xp, EXCLUDED.xp),
         updated_at = now()
       WHERE public.player_site_xp.xp < EXCLUDED.xp
         AND EXCLUDED.xp IS NOT NULL
       RETURNING steam_id::text AS steam_id`,
    );

    return {
      withFaceit,
      checked: withFaceit,
      updated: raised.length,
      behind,
      alreadyOk,
    };
  }

  public async adminSetLevel(
    user: User | undefined,
    body: { steam_id?: string; level?: number },
  ): Promise<SiteXpRow> {
    if (!user?.steam_id || user.role !== "administrator") {
      throw new ForbiddenException("Not allowed");
    }
    const steamId = this.ids([String(body?.steam_id || "")])[0];
    if (!steamId) throw new BadRequestException("Valid steam_id required");
    const level = Math.min(10, Math.max(1, Math.round(Number(body?.level))));
    if (!Number.isFinite(level)) {
      throw new BadRequestException("level 1-10 required");
    }
    const xp = siteXpForLevel(level);
    const rows = await this.postgres.query<
      Array<{ steam_id: string; xp: number }>
    >(
      `INSERT INTO public.player_site_xp (steam_id, xp, updated_at)
       VALUES ($1::bigint, $2, now())
       ON CONFLICT (steam_id) DO UPDATE SET
         xp = EXCLUDED.xp,
         updated_at = now()
       RETURNING steam_id::text AS steam_id, xp`,
      [steamId, xp],
    );
    const row = rows[0];
    if (!row) {
      throw new BadRequestException("Could not save site level");
    }
    return {
      steam_id: row.steam_id,
      xp: Number(row.xp),
      level: siteLevelFromXp(Number(row.xp)),
    };
  }

  private async add(steamId: string, delta: number): Promise<SiteXpRow> {
    const [row] = await this.postgres.query<
      Array<{ steam_id: string; xp: number }>
    >(
      `INSERT INTO public.player_site_xp (steam_id, xp, updated_at)
       VALUES ($1::bigint, GREATEST(0, $2), now())
       ON CONFLICT (steam_id) DO UPDATE SET
         xp = GREATEST(0, player_site_xp.xp + $2),
         updated_at = now()
       RETURNING steam_id::text AS steam_id, xp`,
      [steamId, delta],
    );
    return {
      steam_id: row.steam_id,
      xp: row.xp,
      level: siteLevelFromXp(row.xp),
    };
  }

  private nextDeathStreak(steamId: string): number {
    const streak = (this.deathStreak.get(steamId) || 0) + 1;
    this.deathStreak.set(steamId, streak);
    return streak;
  }

  private throttled(steamId: string, event: SiteXpInput): boolean {
    const kind = String(event.kind || "");
    if (kind !== "team_damage" && kind !== "utility_damage") return false;
    const victim = this.ids([String(event.victim_steam_id || "")])[0] || "";
    const key = `${steamId}:${kind}:${victim}`;
    const now = Date.now();
    const last = this.recent.get(key) || 0;
    if (now - last < 4000) return true;
    this.recent.set(key, now);
    if (this.recent.size > 4000) {
      for (const [id, at] of this.recent) {
        if (now - at > 15000) this.recent.delete(id);
      }
    }
    return false;
  }

  private ids(values: string[]): string[] {
    return [
      ...new Set(
        values
          .map((id) => String(id || "").match(/\b(7656119\d{10})\b/)?.[1])
          .filter(Boolean) as string[],
      ),
    ].slice(0, 64);
  }
}
