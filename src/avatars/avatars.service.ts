import crypto from "crypto";
import { Readable } from "stream";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { S3Service } from "../s3/s3.service";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";
import { SteamConfig } from "../configs/types/SteamConfig";

export type AvatarKind =
  | "teams"
  | "players"
  | "roster-players"
  | "roster-teams"
  | "tournaments";

const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

type SteamPlayerSummary = {
  steamid: string;
  personaname?: string;
  profileurl?: string;
  avatarfull?: string;
  loccountrycode?: string;
};

@Injectable()
export class AvatarsService {
  private readonly steamApiKey: string | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly config: ConfigService,
  ) {
    this.steamApiKey = this.config.get<SteamConfig>("steam")?.steamApiKey;
  }

  /**
   * Site admin: set a player's current ladder ELO.
   * player_elo.type is text FK → e_match_types (not a Postgres enum).
   */
  async setPlayerElo(options: {
    steamId: string;
    type: string;
    elo: number;
    adminSteamId: string;
  }): Promise<{
    steam_id: string;
    type: string;
    previous: number;
    current: number;
    change: number;
  }> {
    const steamId = String(options.steamId || "").match(
      /\b(7656119\d{10})\b/,
    )?.[1];
    if (!steamId) {
      throw new BadRequestException("Valid steam_id required");
    }

    const preferred = String(options.type || "").trim();
    const allowed = [
      "Competitive",
      "Rush",
      "Wingman",
      "Duel",
      "Trios",
    ] as const;
    const preferredCanon =
      allowed.find((t) => t.toLowerCase() === preferred.toLowerCase()) || null;
    if (!preferredCanon) {
      throw new BadRequestException(
        `type must be one of: ${allowed.join(", ")}`,
      );
    }

    const typeRows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM e_match_types WHERE lower(value) = lower($1) LIMIT 1`,
      [preferredCanon],
    );
    const type = typeRows[0]?.value;
    if (!type) {
      throw new BadRequestException(
        `Match type "${preferredCanon}" is not available on this panel`,
      );
    }

    const elo = Math.round(Number(options.elo));
    if (!Number.isFinite(elo) || elo < 0 || elo > 100_000) {
      throw new BadRequestException("elo must be between 0 and 100000");
    }

    const [player] = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text AS steam_id FROM players WHERE steam_id = $1::bigint`,
      [steamId],
    );
    if (!player) {
      throw new BadRequestException("Player not found");
    }

    try {
      const [latest] = await this.postgres.query<
        Array<{ match_id: string; current: string }>
      >(
        `SELECT match_id::text AS match_id, current::text AS current
         FROM player_elo
         WHERE steam_id = $1::bigint AND type = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [steamId, type],
      );

      let previous = latest ? Number(latest.current) : 5000;
      if (!Number.isFinite(previous)) previous = 5000;
      const change = elo - previous;

      if (latest) {
        await this.postgres.query(
          `UPDATE player_elo
           SET current = $1::numeric,
               change = $2::numeric
           WHERE steam_id = $3::bigint
             AND match_id = $4::uuid
             AND type = $5`,
          [elo, change, steamId, latest.match_id, type],
        );
      } else {
        const [donor] = await this.postgres.query<Array<{ id: string }>>(
          `SELECT id::text AS id FROM matches ORDER BY created_at DESC LIMIT 1`,
        );
        if (!donor) {
          throw new BadRequestException(
            "No matches exist yet — cannot seed ELO without a donor match row",
          );
        }
        await this.postgres.query(
          `INSERT INTO player_elo (steam_id, match_id, type, current, change)
           VALUES ($1::bigint, $2::uuid, $3, $4::numeric, $5::numeric)
           ON CONFLICT (steam_id, match_id, type) DO UPDATE SET
             current = EXCLUDED.current,
             change = EXCLUDED.change`,
          [steamId, donor.id, type, elo, change],
        );
      }

      this.logger.log(
        `Admin ${options.adminSteamId} set ELO ${type}=${elo} (was ${previous}) for ${steamId}`,
      );

      return {
        steam_id: steamId,
        type,
        previous,
        current: elo,
        change,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message =
        (error as Error)?.message ||
        (typeof error === "string" ? error : "Failed to set ELO");
      this.logger.error(`setPlayerElo failed for ${steamId}: ${message}`);
      throw new BadRequestException(message);
    }
  }

  /**
   * Pull latest Steam avatarfull (and profile URL) for players and overwrite
   * players.avatar_url. Custom / roster uploads are left alone.
   */
  async refreshSteamAvatars(options: {
    steamIds?: string[];
    all?: boolean;
    limit?: number;
  }): Promise<{ updated: number; checked: number }> {
    if (!this.steamApiKey) {
      throw new BadRequestException("STEAM_WEB_API_KEY is not configured");
    }

    let ids: string[] = [];
    if (options.all) {
      const limit = Math.min(
        50_000,
        Math.max(1, Math.floor(Number(options.limit) || 5000)),
      );
      const rows = await this.postgres.query<Array<{ steam_id: string }>>(
        `SELECT steam_id::text AS steam_id
         FROM players
         ORDER BY last_sign_in_at DESC NULLS LAST, steam_id ASC
         LIMIT $1`,
        [limit],
      );
      ids = rows.map((r) => r.steam_id);
    } else {
      ids = [
        ...new Set(
          (options.steamIds || [])
            .map((id) => String(id || "").match(/\b(7656119\d{10})\b/)?.[1])
            .filter(Boolean) as string[],
        ),
      ].slice(0, 200);
    }

    if (!ids.length) {
      return { updated: 0, checked: 0 };
    }

    let updated = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const summaries = await this.fetchSteamSummaries(batch);
      if (!summaries.length) continue;

      const steamIds: string[] = [];
      const avatars: string[] = [];
      const profiles: (string | null)[] = [];
      for (const s of summaries) {
        if (!s.steamid || !s.avatarfull) continue;
        steamIds.push(s.steamid);
        avatars.push(s.avatarfull);
        profiles.push(s.profileurl || null);
      }
      if (!steamIds.length) continue;

      const result = await this.postgres.query<Array<{ steam_id: string }>>(
        `UPDATE public.players AS p
            SET avatar_url = v.avatar_url,
                profile_url = COALESCE(v.profile_url, p.profile_url)
           FROM (
             SELECT UNNEST($1::bigint[]) AS steam_id,
                    UNNEST($2::text[])   AS avatar_url,
                    UNNEST($3::text[])   AS profile_url
           ) AS v
          WHERE p.steam_id = v.steam_id
            AND (
              p.avatar_url IS DISTINCT FROM v.avatar_url
              OR (v.profile_url IS NOT NULL AND p.profile_url IS DISTINCT FROM v.profile_url)
            )
          RETURNING p.steam_id::text AS steam_id`,
        [steamIds, avatars, profiles],
      );
      updated += result.length;
    }

    this.logger.log(
      `Steam avatar refresh: checked=${ids.length} updated=${updated}`,
    );
    return { updated, checked: ids.length };
  }

  private async fetchSteamSummaries(
    steamIds: string[],
  ): Promise<SteamPlayerSummary[]> {
    if (!this.steamApiKey || !steamIds.length) return [];
    const url = new URL(
      "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/",
    );
    url.searchParams.set("key", this.steamApiKey);
    url.searchParams.set("steamids", steamIds.join(","));
    const res = await fetch(url.toString());
    if (!res.ok) {
      this.logger.warn(`GetPlayerSummaries http ${res.status}`);
      return [];
    }
    const body = (await res.json()) as {
      response?: { players?: SteamPlayerSummary[] };
    };
    return body.response?.players ?? [];
  }

  async uploadTeamAvatar(
    teamId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    const { teams_by_pk } = await this.hasura.query({
      teams_by_pk: {
        __args: { id: teamId },
        owner_steam_id: true,
        avatar_url: true,
      },
    });

    if (!teams_by_pk) {
      throw new ForbiddenException("Team not found");
    }

    if (
      teams_by_pk.owner_steam_id !== user.steam_id &&
      user.role !== "administrator"
    ) {
      throw new ForbiddenException("You do not own this team");
    }

    const path = this.buildPath("teams", teamId, mimetype);

    await this.s3.put(path, buffer);

    if (teams_by_pk.avatar_url && teams_by_pk.avatar_url !== path) {
      await this.s3.remove(teams_by_pk.avatar_url);
    }

    await this.hasura.mutation({
      update_teams_by_pk: {
        __args: {
          pk_columns: { id: teamId },
          _set: { avatar_url: path },
        },
        __typename: true,
      },
    });

    this.logger.log(`Uploaded team ${teamId} avatar to ${path}`);
    return path;
  }

  async removeTeamAvatar(teamId: string, user: User): Promise<void> {
    const { teams_by_pk } = await this.hasura.query({
      teams_by_pk: {
        __args: { id: teamId },
        owner_steam_id: true,
        avatar_url: true,
      },
    });

    if (!teams_by_pk) {
      throw new ForbiddenException("Team not found");
    }

    if (
      teams_by_pk.owner_steam_id !== user.steam_id &&
      user.role !== "administrator"
    ) {
      throw new ForbiddenException("You do not own this team");
    }

    if (teams_by_pk.avatar_url) {
      await this.s3.remove(teams_by_pk.avatar_url);
    }

    await this.hasura.mutation({
      update_teams_by_pk: {
        __args: {
          pk_columns: { id: teamId },
          _set: { avatar_url: null },
        },
        __typename: true,
      },
    });

    this.logger.log(`Removed team ${teamId} avatar`);
  }

  async uploadPlayerAvatar(
    steamId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    if (steamId !== user.steam_id && user.role !== "administrator") {
      throw new ForbiddenException("You cannot change this player's avatar");
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        custom_avatar_url: true,
      },
    });

    if (!players_by_pk) {
      throw new ForbiddenException("Player not found");
    }

    const path = this.buildPath("players", steamId, mimetype);

    await this.s3.put(path, buffer);

    if (
      players_by_pk.custom_avatar_url &&
      players_by_pk.custom_avatar_url !== path
    ) {
      await this.s3.remove(players_by_pk.custom_avatar_url);
    }

    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: { steam_id: steamId },
          _set: { custom_avatar_url: path },
        },
        __typename: true,
      },
    });

    this.logger.log(`Uploaded player ${steamId} avatar to ${path}`);
    return path;
  }

  async removePlayerAvatar(steamId: string, user: User): Promise<void> {
    if (steamId !== user.steam_id && user.role !== "administrator") {
      throw new ForbiddenException("You cannot change this player's avatar");
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        custom_avatar_url: true,
      },
    });

    if (!players_by_pk) {
      throw new ForbiddenException("Player not found");
    }

    if (players_by_pk.custom_avatar_url) {
      await this.s3.remove(players_by_pk.custom_avatar_url);
    }

    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: { steam_id: steamId },
          _set: { custom_avatar_url: null },
        },
        __typename: true,
      },
    });

    this.logger.log(`Removed player ${steamId} custom avatar`);
  }

  async uploadPlayerRosterImage(
    steamId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    if (steamId !== user.steam_id && user.role !== "administrator") {
      throw new ForbiddenException(
        "You cannot change this player's roster image",
      );
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        roster_image_url: true,
      },
    });

    if (!players_by_pk) {
      throw new ForbiddenException("Player not found");
    }

    const path = this.buildPath("roster-players", steamId, mimetype);

    await this.s3.put(path, buffer);

    if (
      players_by_pk.roster_image_url &&
      players_by_pk.roster_image_url !== path
    ) {
      await this.s3.remove(players_by_pk.roster_image_url);
    }

    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: { steam_id: steamId },
          _set: { roster_image_url: path },
        },
        __typename: true,
      },
    });

    this.logger.log(`Uploaded player ${steamId} roster image to ${path}`);
    return path;
  }

  async removePlayerRosterImage(steamId: string, user: User): Promise<void> {
    if (steamId !== user.steam_id && user.role !== "administrator") {
      throw new ForbiddenException(
        "You cannot change this player's roster image",
      );
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        roster_image_url: true,
      },
    });

    if (!players_by_pk) {
      throw new ForbiddenException("Player not found");
    }

    if (players_by_pk.roster_image_url) {
      await this.s3.remove(players_by_pk.roster_image_url);
    }

    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: { steam_id: steamId },
          _set: { roster_image_url: null },
        },
        __typename: true,
      },
    });

    this.logger.log(`Removed player ${steamId} roster image`);
  }

  async uploadTeamRosterPlayerImage(
    teamId: string,
    steamId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    await this.assertTeamRosterEditor(teamId, user);

    const { team_roster } = await this.hasura.query({
      team_roster: {
        __args: {
          where: {
            team_id: { _eq: teamId },
            player_steam_id: { _eq: steamId },
          },
          limit: 1,
        },
        roster_image_url: true,
      },
    });

    const existing = team_roster?.[0];
    if (!existing) {
      throw new ForbiddenException("Player is not on this team's roster");
    }

    const path = this.buildTeamRosterPath(teamId, steamId, mimetype);

    await this.s3.put(path, buffer);

    if (existing.roster_image_url && existing.roster_image_url !== path) {
      await this.s3.remove(existing.roster_image_url);
    }

    await this.hasura.mutation({
      update_team_roster_by_pk: {
        __args: {
          pk_columns: { team_id: teamId, player_steam_id: steamId },
          _set: { roster_image_url: path },
        },
        __typename: true,
      },
    });

    this.logger.log(
      `Uploaded team ${teamId} roster image for player ${steamId} to ${path}`,
    );
    return path;
  }

  async removeTeamRosterPlayerImage(
    teamId: string,
    steamId: string,
    user: User,
  ): Promise<void> {
    await this.assertTeamRosterEditor(teamId, user);

    const { team_roster } = await this.hasura.query({
      team_roster: {
        __args: {
          where: {
            team_id: { _eq: teamId },
            player_steam_id: { _eq: steamId },
          },
          limit: 1,
        },
        roster_image_url: true,
      },
    });

    const existing = team_roster?.[0];
    if (!existing) {
      throw new ForbiddenException("Player is not on this team's roster");
    }

    if (existing.roster_image_url) {
      await this.s3.remove(existing.roster_image_url);
    }

    await this.hasura.mutation({
      update_team_roster_by_pk: {
        __args: {
          pk_columns: { team_id: teamId, player_steam_id: steamId },
          _set: { roster_image_url: null },
        },
        __typename: true,
      },
    });

    this.logger.log(
      `Removed team ${teamId} roster image for player ${steamId}`,
    );
  }

  async uploadTournamentLogo(
    tournamentId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    const { logo } = await this.assertTournamentOrganizer(tournamentId, user);

    const path = this.buildPath("tournaments", tournamentId, mimetype);

    await this.s3.put(path, buffer);

    if (logo && logo !== path) {
      await this.s3.remove(logo);
    }

    await this.hasura.mutation({
      update_tournaments_by_pk: {
        __args: {
          pk_columns: { id: tournamentId },
          _set: { logo: path },
        },
        __typename: true,
      },
    });

    this.logger.log(`Uploaded tournament ${tournamentId} logo to ${path}`);
    return path;
  }

  async removeTournamentLogo(tournamentId: string, user: User): Promise<void> {
    const { logo } = await this.assertTournamentOrganizer(tournamentId, user);

    if (logo) {
      await this.s3.remove(logo);
    }

    await this.hasura.mutation({
      update_tournaments_by_pk: {
        __args: {
          pk_columns: { id: tournamentId },
          _set: { logo: null },
        },
        __typename: true,
      },
    });

    this.logger.log(`Removed tournament ${tournamentId} logo`);
  }

  async uploadTournamentBanner(
    tournamentId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    const { banner } = await this.assertTournamentOrganizer(tournamentId, user);

    const path = this.buildPath("tournaments", tournamentId, mimetype);

    await this.s3.put(path, buffer);

    if (banner && banner !== path) {
      await this.s3.remove(banner);
    }

    await this.hasura.mutation({
      update_tournaments_by_pk: {
        __args: {
          pk_columns: { id: tournamentId },
          _set: { banner: path },
        },
        __typename: true,
      },
    });

    this.logger.log(`Uploaded tournament ${tournamentId} banner to ${path}`);
    return path;
  }

  async removeTournamentBanner(
    tournamentId: string,
    user: User,
  ): Promise<void> {
    const { banner } = await this.assertTournamentOrganizer(tournamentId, user);

    if (banner) {
      await this.s3.remove(banner);
    }

    await this.hasura.mutation({
      update_tournaments_by_pk: {
        __args: {
          pk_columns: { id: tournamentId },
          _set: { banner: null },
        },
        __typename: true,
      },
    });

    this.logger.log(`Removed tournament ${tournamentId} banner`);
  }

  // Returns the existing logo/banner paths when the caller may manage the tournament.
  private async assertTournamentOrganizer(
    tournamentId: string,
    user: User,
  ): Promise<{
    logo: string | null | undefined;
    banner: string | null | undefined;
  }> {
    const { tournaments_by_pk } = await this.hasura.query({
      tournaments_by_pk: {
        __args: { id: tournamentId },
        logo: true,
        banner: true,
        organizer_steam_id: true,
        organizers: {
          __args: {
            where: { steam_id: { _eq: user.steam_id } },
            limit: 1,
          },
          steam_id: true,
        },
      },
    });

    if (!tournaments_by_pk) {
      throw new ForbiddenException("Tournament not found");
    }

    const isOrganizer =
      user.role === "administrator" ||
      tournaments_by_pk.organizer_steam_id === user.steam_id ||
      (tournaments_by_pk.organizers?.length ?? 0) > 0;

    if (!isOrganizer) {
      throw new ForbiddenException("You do not organize this tournament");
    }

    return { logo: tournaments_by_pk.logo, banner: tournaments_by_pk.banner };
  }

  async getStream(
    kind: AvatarKind,
    filename: string,
  ): Promise<{ stream: Readable; contentType: string; etag?: string } | null> {
    const key = `avatars/${kind}/${filename}`;

    if (!(await this.s3.has(key))) {
      return null;
    }

    const [stream, stat] = await Promise.all([
      this.s3.get(key),
      this.s3.stat(key),
    ]);

    return {
      stream,
      contentType:
        stat.metaData?.["content-type"] || this.guessContentType(filename),
      etag: stat.etag,
    };
  }

  private buildPath(kind: AvatarKind, id: string, mimetype: string): string {
    const ext = EXTENSION_BY_MIMETYPE[mimetype] || "png";
    const hash = crypto.randomBytes(6).toString("hex");
    return `avatars/${kind}/${id}-${hash}.${ext}`;
  }

  private buildTeamRosterPath(
    teamId: string,
    steamId: string,
    mimetype: string,
  ): string {
    const ext = EXTENSION_BY_MIMETYPE[mimetype] || "png";
    const hash = crypto.randomBytes(6).toString("hex");
    return `avatars/roster-teams/${teamId}-${steamId}-${hash}.${ext}`;
  }

  private async assertTeamRosterEditor(
    teamId: string,
    user: User,
  ): Promise<void> {
    if (
      user.role === "administrator" ||
      user.role === "tournament_organizer" ||
      user.role === "match_organizer"
    ) {
      return;
    }

    const { teams_by_pk } = await this.hasura.query({
      teams_by_pk: {
        __args: { id: teamId },
        owner_steam_id: true,
        roster: {
          __args: {
            where: {
              player_steam_id: { _eq: user.steam_id },
            },
            limit: 1,
          },
          role: true,
        },
      },
    });

    if (!teams_by_pk) {
      throw new ForbiddenException("Team not found");
    }

    if (teams_by_pk.owner_steam_id === user.steam_id) {
      return;
    }

    const rosterEntry = teams_by_pk.roster?.[0];
    if (rosterEntry?.role === "Admin") {
      return;
    }

    throw new ForbiddenException(
      "You do not have permission to manage this team's roster images",
    );
  }

  private guessContentType(filename: string): string {
    if (filename.endsWith(".png")) return "image/png";
    if (filename.endsWith(".jpg") || filename.endsWith(".jpeg"))
      return "image/jpeg";
    if (filename.endsWith(".webp")) return "image/webp";
    return "application/octet-stream";
  }
}
