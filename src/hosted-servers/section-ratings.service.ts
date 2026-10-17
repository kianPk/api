import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { isServerSectionMode } from "../game-plugins/server-section-modes";
import { PublicRanksService } from "./public-ranks.service";
import { User } from "../auth/types/User";

export type SectionRatingRow = {
  steam_id: string;
  rating: number;
  name: string | null;
  level: number;
};

const START_RATING = 1000;

@Injectable()
export class SectionRatingsService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly ranks: PublicRanksService,
  ) {}

  public authenticateServer(serverId: string, authorization: unknown) {
    return this.ranks.authenticateServer(serverId, authorization);
  }

  public assertMode(mode: string): string {
    if (!isServerSectionMode(mode)) {
      throw new BadRequestException("unknown section mode");
    }
    return mode;
  }

  // Faceit Elo bands — same as the ServersModes ScoreboardLevel helper.
  public static levelFromElo(elo: number): number {
    if (elo < 501) return 1;
    if (elo < 751) return 2;
    if (elo < 901) return 3;
    if (elo < 1051) return 4;
    if (elo < 1201) return 5;
    if (elo < 1351) return 6;
    if (elo < 1531) return 7;
    if (elo < 1751) return 8;
    if (elo < 2001) return 9;
    return 10;
  }

  // Floor of each band so an admin set to level N always lands on N.
  public static ratingForLevel(level: number): number {
    const floors = [0, 1, 501, 751, 901, 1051, 1201, 1351, 1531, 1751, 2001];
    const n = Math.min(10, Math.max(1, Math.round(Number(level) || 1)));
    return floors[n];
  }

  public async get(
    mode: string,
    steamIds: string[],
  ): Promise<SectionRatingRow[]> {
    const ids = [
      ...new Set(
        steamIds
          .map((id) => String(id || "").match(/\b(7656119\d{10})\b/)?.[1])
          .filter(Boolean) as string[],
      ),
    ].slice(0, 64);
    if (!ids.length) {
      return [];
    }

    const rows = await this.postgres.query<
      Array<{ steam_id: string; rating: number; name: string | null }>
    >(
      `SELECT steam_id::text AS steam_id, rating, name
         FROM public.servers_section_ratings
        WHERE mode = $1 AND steam_id = ANY($2::bigint[])`,
      [mode, ids],
    );

    const byId = new Map(rows.map((row) => [row.steam_id, row]));
    return ids.map((steamId) => {
      const row = byId.get(steamId);
      const rating = row?.rating ?? START_RATING;
      return {
        steam_id: steamId,
        rating,
        name: row?.name ?? null,
        level: SectionRatingsService.levelFromElo(rating),
      };
    });
  }

  /** Site read: only rows that exist (no default level for missing players). */
  public async getExisting(
    mode: string,
    steamIds: string[],
  ): Promise<SectionRatingRow[]> {
    const ids = [
      ...new Set(
        steamIds
          .map((id) => String(id || "").match(/\b(7656119\d{10})\b/)?.[1])
          .filter(Boolean) as string[],
      ),
    ].slice(0, 64);
    if (!ids.length) {
      return [];
    }

    const rows = await this.postgres.query<
      Array<{ steam_id: string; rating: number; name: string | null }>
    >(
      `SELECT steam_id::text AS steam_id, rating, name
         FROM public.servers_section_ratings
        WHERE mode = $1 AND steam_id = ANY($2::bigint[])`,
      [mode, ids],
    );

    return rows.map((row) => ({
      steam_id: row.steam_id,
      rating: row.rating,
      name: row.name ?? null,
      level: SectionRatingsService.levelFromElo(row.rating),
    }));
  }

  public async upsert(
    mode: string,
    updates: Array<{ steam_id?: string; rating?: number; name?: string }>,
  ): Promise<SectionRatingRow[]> {
    const cleaned = updates
      .map((entry) => {
        const steamId = String(entry.steam_id || "").match(
          /\b(7656119\d{10})\b/,
        )?.[1];
        const rating = Number(entry.rating);
        if (!steamId || !Number.isFinite(rating)) {
          return null;
        }
        return {
          steam_id: steamId,
          rating: Math.min(5000, Math.max(0, rating)),
          name: String(entry.name || "")
            .replace(/[\x00-\x1f]/g, "")
            .trim()
            .slice(0, 64),
        };
      })
      .filter(Boolean)
      .slice(0, 64) as Array<{
      steam_id: string;
      rating: number;
      name: string;
    }>;

    if (!cleaned.length) {
      throw new BadRequestException("no valid rating updates");
    }

    for (const row of cleaned) {
      await this.postgres.query(
        `INSERT INTO public.servers_section_ratings (mode, steam_id, rating, name)
         VALUES ($1, $2::bigint, $3, NULLIF($4, ''))
         ON CONFLICT (mode, steam_id) DO UPDATE SET
           rating = EXCLUDED.rating,
           name = COALESCE(NULLIF(EXCLUDED.name, ''), servers_section_ratings.name),
           updated_at = now()`,
        [mode, row.steam_id, row.rating, row.name],
      );
    }

    return this.get(
      mode,
      cleaned.map((row) => row.steam_id),
    );
  }

  /** Site administrator: set a player's Faceit-style level for a section mode. */
  public async adminSetLevel(
    user: User | undefined,
    mode: string,
    body: { steam_id?: string; level?: number; name?: string },
  ): Promise<SectionRatingRow> {
    if (!user?.steam_id || user.role !== "administrator") {
      throw new ForbiddenException("Not allowed");
    }
    const key = this.assertMode(mode);
    const steamId = String(body?.steam_id || "").match(
      /\b(7656119\d{10})\b/,
    )?.[1];
    if (!steamId) {
      throw new BadRequestException("Valid steam_id required");
    }
    const level = Math.min(10, Math.max(1, Math.round(Number(body?.level))));
    if (!Number.isFinite(level)) {
      throw new BadRequestException("level 1-10 required");
    }
    const [player] = await this.postgres.query<Array<{ name: string | null }>>(
      `SELECT name FROM players WHERE steam_id = $1::bigint`,
      [steamId],
    );
    const [row] = await this.upsert(key, [
      {
        steam_id: steamId,
        rating: SectionRatingsService.ratingForLevel(level),
        name: body?.name || player?.name || undefined,
      },
    ]);
    return row;
  }
}
