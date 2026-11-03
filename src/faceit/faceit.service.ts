import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { SiteXpService } from "../site-xp/site-xp.service";

export type FaceitPlayerData = {
  faceit_player_id: string;
  faceit_nickname: string;
  faceit_url: string | null;
  faceit_skill_level: number | null;
  faceit_elo: number | null;
};

@Injectable()
export class FaceitService {
  private static readonly BASE_URL = "https://open.faceit.com/data/v4";
  private static readonly REFRESH_INTERVAL_SECONDS = 60 * 60;
  private static readonly NO_ACCOUNT_TTL_SECONDS = 12 * 60 * 60;
  private readonly apiKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly siteXp: SiteXpService,
    private readonly logger: Logger,
  ) {
    this.apiKey = this.config.get("faceit.apiKey");
  }

  public isEnabled(): boolean {
    return !!this.apiKey;
  }

  public async testIntegration(steamId?: string): Promise<{
    dataApi: { ok: boolean; detail: string };
    downloadApi: { ok: boolean | null; detail: string };
  }> {
    if (!this.apiKey) {
      const detail = "FACEIT_API_KEY not configured";
      return {
        dataApi: { ok: false, detail },
        downloadApi: { ok: false, detail },
      };
    }

    let dataApi: { ok: boolean; detail: string };
    try {
      const res = await fetch(`${FaceitService.BASE_URL}/games/cs2`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      dataApi = res.ok
        ? { ok: true, detail: "Data API authorized (ranks/match metadata)" }
        : { ok: false, detail: `Data API responded ${res.status}` };
    } catch (error) {
      dataApi = {
        ok: false,
        detail: `Data API error: ${(error as Error)?.message ?? "unknown"}`,
      };
    }

    const resourceUrl = await this.findTestableDemoUrl(steamId);
    let downloadApi: { ok: boolean | null; detail: string };
    if (!resourceUrl) {
      downloadApi = {
        ok: null,
        detail:
          "Not tested — no recent Faceit demo on your account to sign. Demo import still requires Downloads API access.",
      };
    } else {
      try {
        const res = await fetch(
          "https://open.faceit.com/download/v2/demos/download",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ resource_url: resourceUrl }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (res.status === 403) {
          downloadApi = {
            ok: false,
            detail:
              "Downloads API not authorized — apply at https://fce.gg/downloads-api-application",
          };
        } else if (res.ok) {
          downloadApi = {
            ok: true,
            detail: "Downloads API authorized (signed a real demo)",
          };
        } else {
          downloadApi = {
            ok: false,
            detail: `Downloads API responded ${res.status}`,
          };
        }
      } catch (error) {
        downloadApi = {
          ok: false,
          detail: `Downloads API error: ${(error as Error)?.message ?? "unknown"}`,
        };
      }
    }

    return { dataApi, downloadApi };
  }

  private async findTestableDemoUrl(steamId?: string): Promise<string | null> {
    if (!steamId) {
      return null;
    }
    const playerId = await this.resolvePlayerId(steamId);
    if (!playerId) {
      return null;
    }
    const matches = await this.getRecentMatches(playerId, { limit: 5 });
    for (const match of matches) {
      const { demoUrl } = await this.getMatchDemo(match.matchId);
      if (demoUrl) {
        return demoUrl;
      }
    }
    return null;
  }

  public async signDownloadUrl(resourceUrl: string): Promise<string | null> {
    if (!this.apiKey) {
      return null;
    }
    try {
      const response = await fetch(
        "https://open.faceit.com/download/v2/demos/download",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ resource_url: resourceUrl }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) {
        this.logger.error(
          `faceit downloads api ${response.status} for ${resourceUrl}`,
        );
        return null;
      }
      const data = (await response.json()) as {
        payload?: { download_url?: string };
      };
      return data.payload?.download_url ?? null;
    } catch (error) {
      this.logger.error(
        `faceit downloads api failed for ${resourceUrl}`,
        error,
      );
      return null;
    }
  }

  public static extractMatchId(input: string): string | null {
    const trimmed = (input ?? "").trim();
    const fromRoom = trimmed.match(/room\/(1-[0-9a-fA-F-]+)/);
    if (fromRoom) {
      return fromRoom[1];
    }
    if (/^1-[0-9a-fA-F-]+$/.test(trimmed)) {
      return trimmed;
    }
    return null;
  }

  public async resolvePlayerId(steamId: string): Promise<string | null> {
    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        faceit_player_id: true,
      },
    });
    if (players_by_pk?.faceit_player_id) {
      return players_by_pk.faceit_player_id;
    }

    const noAccountKey = FaceitService.noAccountKey(steamId);
    if (await this.cache.has(noAccountKey)) {
      return null;
    }

    const data = await this.fetchPlayer(steamId);
    if (!data?.faceit_player_id) {
      await this.cache.put(
        noAccountKey,
        true,
        FaceitService.NO_ACCOUNT_TTL_SECONDS,
      );
      return null;
    }
    return data.faceit_player_id;
  }

  public async getRecentMatches(
    playerId: string,
    options: { sinceSeconds?: number; limit?: number } = {},
  ): Promise<Array<{ matchId: string; finishedAt: number | null }>> {
    const limit = options.limit ?? 20;
    const from = options.sinceSeconds ? `&from=${options.sinceSeconds}` : "";
    const data = await this.get<{
      items?: Array<{ match_id: string; finished_at?: number }>;
    }>(
      `/players/${encodeURIComponent(playerId)}/history?game=cs2&offset=0&limit=${limit}${from}`,
    );
    return (data?.items ?? [])
      .filter((item) => item.match_id)
      .map((item) => ({
        matchId: item.match_id,
        finishedAt: item.finished_at ?? null,
      }));
  }

  // Best-effort per-match elo from the match page (keyed by steam id). Returns
  // whatever the match roster exposes — FACEIT does not always include elo, so
  // callers fall back to the player's current elo when a steam id is absent.
  public async getMatchEloMap(
    matchId: string,
  ): Promise<Record<string, number>> {
    const data = await this.get<{
      teams?: Record<
        string,
        {
          roster?: Array<{ game_player_id?: string; elo?: number }>;
        }
      >;
    }>(`/matches/${encodeURIComponent(matchId)}`);
    const out: Record<string, number> = {};
    for (const team of Object.values(data?.teams ?? {})) {
      for (const member of team.roster ?? []) {
        if (
          member.game_player_id &&
          /^\d+$/.test(member.game_player_id) &&
          typeof member.elo === "number"
        ) {
          out[member.game_player_id] = member.elo;
        }
      }
    }
    return out;
  }

  public async getMatchDemo(
    matchId: string,
  ): Promise<{ demoUrl: string | null; startedAt: string | null }> {
    const data = await this.get<{
      demo_url?: string[];
      started_at?: number;
      finished_at?: number;
    }>(`/matches/${encodeURIComponent(matchId)}`);
    const demoUrl = (data?.demo_url ?? []).find((url) => !!url) ?? null;
    const ts = data?.finished_at ?? data?.started_at ?? null;
    return {
      demoUrl,
      startedAt: ts ? new Date(ts * 1000).toISOString() : null,
    };
  }

  private async get<T>(path: string): Promise<T | null> {
    const url = `${FaceitService.BASE_URL}${path}`;
    this.logger.debug(`faceit GET ${url}`);
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        this.logger.error(
          `faceit responded with ${response.status} for ${path}`,
        );
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      this.logger.error(`faceit request failed for ${path}`, error);
      return null;
    }
  }

  public async refreshPlayer(steamId: string, force = false): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    const cacheKey = FaceitService.cacheKey(steamId);
    if (!force && (await this.cache.has(cacheKey))) {
      return false;
    }

    await this.cache.put(
      cacheKey,
      true,
      FaceitService.REFRESH_INTERVAL_SECONDS,
    );

    this.logger.debug(`faceit refresh start for ${steamId}`);
    const startedAt = Date.now();
    const data = await this.fetchPlayer(steamId);
    const elapsedMs = Date.now() - startedAt;

    if (!data) {
      // No faceit profile linked to this steam id. The redis lock will
      // keep us from re-querying for an hour; we deliberately do NOT
      // touch the players row so the columns stay NULL and the UI keeps
      // the chip hidden.
      this.logger.debug(
        `faceit fetched for ${steamId} in ${elapsedMs}ms: no profile, skipping db write`,
      );
      return false;
    }

    this.logger.debug(
      `faceit fetched for ${steamId} in ${elapsedMs}ms: ` +
        `nickname=${data.faceit_nickname} ` +
        `level=${data.faceit_skill_level} ` +
        `elo=${data.faceit_elo}`,
    );

    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: { steam_id: steamId },
          _set: {
            faceit_player_id: data.faceit_player_id,
            faceit_nickname: data.faceit_nickname,
            faceit_skill_level: data.faceit_skill_level,
            faceit_elo: data.faceit_elo,
            faceit_url: data.faceit_url,
            faceit_updated_at: new Date(),
          },
        },
        __typename: true,
      },
    });

    // On first sync (and later climbs), mirror FACEIT skill onto site level.
    // ensureMinLevel never lowers an already-higher site level.
    const faceitLevel = Math.round(Number(data.faceit_skill_level));
    if (Number.isFinite(faceitLevel) && faceitLevel >= 1 && faceitLevel <= 10) {
      try {
        await this.siteXp.ensureMinLevel(steamId, faceitLevel);
      } catch (err) {
        this.logger.warn(
          `faceit site level bump failed for ${steamId}: ${String(err)}`,
        );
      }
    }

    this.logger.debug(`faceit row written for ${steamId}`);

    return true;
  }

  /**
   * Backfill / refresh FACEIT ranks for recently active players whose
   * faceit_* columns are missing or stale. Bounded batch + delay to stay
   * within FACEIT Data API rate limits.
   *
   * Steam IDs come from Postgres as text — never Hasura JSON numbers
   * (Steam64 exceeds Number.MAX_SAFE_INTEGER and gets corrupted).
   */
  public async refreshStalePlayers(
    limit = 40,
    force = false,
  ): Promise<{ checked: number; updated: number; missing: number }> {
    if (!this.isEnabled()) {
      return { checked: 0, updated: 0, missing: 0 };
    }

    const batch = Math.min(120, Math.max(1, Math.round(limit)));
    const players = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text AS steam_id
         FROM public.players
        WHERE last_sign_in_at >= now() - interval '90 days'
          AND (
            faceit_skill_level IS NULL
            OR faceit_updated_at IS NULL
            OR faceit_updated_at < now() - interval '24 hours'
          )
        ORDER BY
          (faceit_skill_level IS NULL) DESC,
          last_sign_in_at DESC NULLS LAST
        LIMIT $1`,
      [batch],
    );

    return this.refreshSteamIds(
      players.map((row) => row.steam_id),
      force,
      250,
    );
  }

  /**
   * Admin site-level sync candidates: anyone with Faceit hints OR recent login.
   * Prefer filling missing skill first. Steam IDs as text from Postgres.
   */
  public async refreshCandidatesForSiteSync(
    limit = 60,
    force = true,
  ): Promise<{ checked: number; updated: number; missing: number }> {
    if (!this.isEnabled()) {
      return { checked: 0, updated: 0, missing: 0 };
    }

    const batch = Math.min(200, Math.max(1, Math.round(limit)));
    const players = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text AS steam_id
         FROM public.players
        WHERE (
            faceit_skill_level IS NULL
            OR faceit_player_id IS NOT NULL
            OR (faceit_nickname IS NOT NULL AND btrim(faceit_nickname) <> '')
            OR last_sign_in_at >= now() - interval '180 days'
          )
        ORDER BY
          (faceit_skill_level IS NULL) DESC,
          last_sign_in_at DESC NULLS LAST
        LIMIT $1`,
      [batch],
    );

    return this.refreshSteamIds(
      players.map((row) => row.steam_id),
      force,
      200,
    );
  }

  /**
   * Force-refresh FACEIT for players that already have a skill level saved.
   */
  public async refreshPlayersWithFaceit(
    limit = 80,
    force = true,
  ): Promise<{ checked: number; updated: number; missing: number }> {
    if (!this.isEnabled()) {
      return { checked: 0, updated: 0, missing: 0 };
    }

    const batch = Math.min(200, Math.max(1, Math.round(limit)));
    const players = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text AS steam_id
         FROM public.players
        WHERE faceit_skill_level IS NOT NULL
          AND faceit_skill_level BETWEEN 1 AND 10
          AND last_sign_in_at >= now() - interval '180 days'
        ORDER BY last_sign_in_at DESC NULLS LAST
        LIMIT $1`,
      [batch],
    );

    return this.refreshSteamIds(
      players.map((row) => row.steam_id),
      force,
      200,
    );
  }

  public async diagnoseFaceitColumns(): Promise<{
    withSkill1to10: number;
    withSkillAny: number;
    withSkillZero: number;
    withNickname: number;
    withPlayerId: number;
    withAnyFaceit: number;
    faceitEnabled: boolean;
    samples: Array<{
      steam_id: string;
      name: string | null;
      faceit_nickname: string | null;
      faceit_player_id: string | null;
      faceit_skill_level: number | null;
      faceit_elo: number | null;
    }>;
  }> {
    const [row] = await this.postgres.query<
      Array<{
        with_skill_1_10: number;
        with_skill_any: number;
        with_skill_zero: number;
        with_nickname: number;
        with_player_id: number;
        with_any_faceit: number;
      }>
    >(
      `SELECT
         COUNT(*) FILTER (
           WHERE faceit_skill_level BETWEEN 1 AND 10
         )::int AS with_skill_1_10,
         COUNT(*) FILTER (
           WHERE faceit_skill_level IS NOT NULL
         )::int AS with_skill_any,
         COUNT(*) FILTER (
           WHERE faceit_skill_level = 0
         )::int AS with_skill_zero,
         COUNT(*) FILTER (
           WHERE faceit_nickname IS NOT NULL AND btrim(faceit_nickname) <> ''
         )::int AS with_nickname,
         COUNT(*) FILTER (
           WHERE faceit_player_id IS NOT NULL
         )::int AS with_player_id,
         COUNT(*) FILTER (
           WHERE faceit_skill_level IS NOT NULL
              OR faceit_player_id IS NOT NULL
              OR (faceit_nickname IS NOT NULL AND btrim(faceit_nickname) <> '')
         )::int AS with_any_faceit
       FROM public.players`,
    );

    const samples = await this.postgres.query<
      Array<{
        steam_id: string;
        name: string | null;
        faceit_nickname: string | null;
        faceit_player_id: string | null;
        faceit_skill_level: number | null;
        faceit_elo: number | null;
      }>
    >(
      `SELECT steam_id::text AS steam_id,
              name,
              faceit_nickname,
              faceit_player_id,
              faceit_skill_level,
              faceit_elo
         FROM public.players
        WHERE faceit_skill_level IS NOT NULL
           OR faceit_player_id IS NOT NULL
           OR (faceit_nickname IS NOT NULL AND btrim(faceit_nickname) <> '')
        ORDER BY faceit_updated_at DESC NULLS LAST
        LIMIT 15`,
    );

    return {
      withSkill1to10: Number(row?.with_skill_1_10 ?? 0),
      withSkillAny: Number(row?.with_skill_any ?? 0),
      withSkillZero: Number(row?.with_skill_zero ?? 0),
      withNickname: Number(row?.with_nickname ?? 0),
      withPlayerId: Number(row?.with_player_id ?? 0),
      withAnyFaceit: Number(row?.with_any_faceit ?? 0),
      faceitEnabled: this.isEnabled(),
      samples,
    };
  }

  private async refreshSteamIds(
    steamIds: string[],
    force: boolean,
    delayMs: number,
  ): Promise<{ checked: number; updated: number; missing: number }> {
    let updated = 0;
    let notFound = 0;
    for (const raw of steamIds) {
      const steamId = String(raw || "").trim();
      if (!/^\d{5,20}$/.test(steamId)) continue;
      try {
        const ok = await this.refreshPlayer(steamId, force);
        if (ok) updated += 1;
        else notFound += 1;
      } catch (error) {
        this.logger.warn(
          `faceit refresh failed for ${steamId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
        notFound += 1;
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }

    return {
      checked: steamIds.length,
      updated,
      missing: notFound,
    };
  }

  private async fetchPlayer(steamId: string): Promise<FaceitPlayerData | null> {
    // Prefer CS2; fall back to CSGO for older FACEIT accounts that never
    // migrated their game stats.
    const cs2 = await this.fetchPlayerForGame(steamId, "cs2");
    if (cs2?.faceit_skill_level != null) {
      return cs2;
    }
    const csgo = await this.fetchPlayerForGame(steamId, "csgo");
    if (csgo?.faceit_skill_level != null) {
      return csgo;
    }
    return cs2 ?? csgo;
  }

  private async fetchPlayerForGame(
    steamId: string,
    game: "cs2" | "csgo",
  ): Promise<FaceitPlayerData | null> {
    const url = `${FaceitService.BASE_URL}/players?game=${game}&game_player_id=${encodeURIComponent(
      steamId,
    )}`;

    this.logger.debug(`faceit GET ${url}`);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
      });

      if (response.status === 404) {
        this.logger.debug(
          `faceit 404 for steam_id ${steamId} game=${game} — no faceit account linked`,
        );
        return null;
      }

      if (!response.ok) {
        this.logger.error(
          `faceit responded with ${response.status} for steam_id ${steamId} game=${game}`,
        );
        return null;
      }

      const data = (await response.json()) as {
        player_id: string;
        nickname: string;
        faceit_url?: string;
        games?: {
          cs2?: {
            skill_level?: number;
            faceit_elo?: number;
          };
          csgo?: {
            skill_level?: number;
            faceit_elo?: number;
          };
        };
      };

      const stats = data.games?.cs2 ?? data.games?.csgo;

      return {
        faceit_player_id: data.player_id,
        faceit_nickname: data.nickname,
        faceit_url: data.faceit_url
          ? data.faceit_url.replace("{lang}", "en")
          : null,
        faceit_skill_level: stats?.skill_level ?? null,
        faceit_elo: stats?.faceit_elo ?? null,
      };
    } catch (error) {
      this.logger.error(
        `unable to fetch faceit profile for steam_id ${steamId} game=${game}`,
        error,
      );
      return null;
    }
  }

  private static cacheKey(steamId: string): string {
    return `faceit:refresh-lock:cs2:${steamId}`;
  }

  private static noAccountKey(steamId: string): string {
    return `faceit:no-account:cs2:${steamId}`;
  }
}
