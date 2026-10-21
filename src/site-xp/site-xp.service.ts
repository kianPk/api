import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";
import {
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

@Injectable()
export class SiteXpService {
  private readonly recent = new Map<string, number>();

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

  public async apply(input: SiteXpInput): Promise<SiteXpRow | null> {
    const [row] = await this.applyMany([input]);
    return row ?? null;
  }

  public async applyMany(events: SiteXpInput[]): Promise<SiteXpRow[]> {
    const deltas = new Map<string, number>();
    for (const event of events.slice(0, 64)) {
      const steamId = this.ids([String(event.steam_id || "")])[0];
      const delta = siteXpDelta(event);
      if (!steamId || !delta || this.throttled(steamId, event)) continue;
      deltas.set(steamId, (deltas.get(steamId) || 0) + delta);
    }
    const out: SiteXpRow[] = [];
    for (const [steamId, delta] of deltas) {
      out.push(await this.add(steamId, delta));
    }
    return out;
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
    const [row] = await this.postgres.query<
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
    return {
      steam_id: row.steam_id,
      xp: row.xp,
      level: siteLevelFromXp(row.xp),
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
