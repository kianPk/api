import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";

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

    this.logger.debug(`faceit row written for ${steamId}`);

    return true;
  }

  /**
   * Backfill / refresh FACEIT ranks for recently active players whose
   * faceit_* columns are missing or stale. Bounded batch + delay to stay
   * within FACEIT Data API rate limits.
   */
  public async refreshStalePlayers(
    limit = 40,
    force = false,
  ): Promise<{ checked: number; updated: number; missing: number }> {
    if (!this.isEnabled()) {
      return { checked: 0, updated: 0, missing: 0 };
    }

    const batch = Math.min(120, Math.max(1, Math.round(limit)));
    const activeSince = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const staleBefore = new Date(
      Date.now() - 24 * 60 * 60 * 1000,
    ).toISOString();

    // Prefer players who still have no FACEIT level, then stale rows.
    const withoutLevel = await this.hasura.query({
      players: {
        __args: {
          where: {
            last_sign_in_at: { _gte: activeSince },
            faceit_skill_level: { _is_null: true },
          },
          order_by: [{ last_sign_in_at: "desc" }],
          limit: batch,
        },
        steam_id: true,
      },
    });

    const need = Math.max(0, batch - (withoutLevel.players?.length ?? 0));
    const stale =
      need > 0
        ? await this.hasura.query({
            players: {
              __args: {
                where: {
                  last_sign_in_at: { _gte: activeSince },
                  faceit_skill_level: { _is_null: false },
                  faceit_updated_at: { _lt: staleBefore },
                },
                order_by: [{ last_sign_in_at: "desc" }],
                limit: need,
              },
              steam_id: true,
            },
          })
        : { players: [] as Array<{ steam_id: string }> };

    const seen = new Set<string>();
    const players: Array<{ steam_id: string }> = [];
    for (const row of [
      ...(withoutLevel.players ?? []),
      ...(stale.players ?? []),
    ]) {
      const id = String(row.steam_id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      players.push({ steam_id: id });
    }

    let updated = 0;
    let notFound = 0;
    for (const row of players) {
      const steamId = String(row.steam_id || "");
      if (!steamId) continue;
      try {
        const ok = await this.refreshPlayer(steamId, force);
        if (ok) {
          updated += 1;
        } else {
          notFound += 1;
        }
      } catch (error) {
        this.logger.warn(
          `faceit stale refresh failed for ${steamId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
        notFound += 1;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    return {
      checked: players.length,
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
