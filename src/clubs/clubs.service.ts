import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { PostgresService } from "../postgres/postgres.service";
import { HasuraService } from "../hasura/hasura.service";
import { YpointService } from "../ypoint/ypoint.service";
import { User } from "../auth/types/User";

const OWN_CLUB_TAG = "OwnClub";
const CLAN_TAG_CACHE_MS = 15_000;

@Injectable()
export class ClubsService {
  private clanTagCache: { at: number; map: Map<string, string> } | null = null;

  constructor(
    private readonly postgres: PostgresService,
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly ypoint: YpointService,
  ) {}

  public async createClub(
    steamId: string,
    input: {
      name: string;
      short_name?: string | null;
      description: string;
      join_mode: string;
    },
  ) {
    await this.assertCanOwnClub(steamId);
    const name = input.name.trim();
    if (name.length < 2) throw new BadRequestException("Club name is required");
    const shortName = (input.short_name || "").trim().slice(0, 5) || null;
    const joinMode = ["open", "request", "invite_only"].includes(
      input.join_mode,
    )
      ? input.join_mode
      : "open";
    try {
      const rows = await this.postgres.query<
        Array<{ id: string; slug: string }>
      >(
        `INSERT INTO public.clubs (name, short_name, description, join_mode, owner_steam_id)
         VALUES ($1, $2, $3, $4, $5::bigint)
         RETURNING id::text, slug`,
        [name, shortName, input.description ?? "", joinMode, steamId],
      );
      const club = rows.at(0);
      if (!club) throw new BadRequestException("Could not create club");
      this.invalidateClanTags();
      return { success: true, ...club };
    } catch (err) {
      this.rethrowClubRule(err);
    }
  }

  public async transferClub(
    clubId: string,
    actorSteamId: string,
    newOwnerSteamId: string,
  ) {
    const target = String(newOwnerSteamId || "").trim();
    if (!target) throw new BadRequestException("New owner is required");
    const clubs = await this.postgres.query<Array<{ owner_steam_id: string }>>(
      `SELECT owner_steam_id::text FROM public.clubs WHERE id = $1::uuid`,
      [clubId],
    );
    const club = clubs.at(0);
    if (!club) throw new BadRequestException("Club not found");
    if (
      club.owner_steam_id !== actorSteamId &&
      !(await this.isSiteAdmin(actorSteamId))
    ) {
      throw new ForbiddenException("Only the club owner can transfer it");
    }
    await this.assertCanOwnClub(target);
    try {
      await this.postgres.query(
        `UPDATE public.teams t
         SET owner_steam_id = $2::bigint
         FROM public.clubs c
         WHERE c.id = $1::uuid
           AND c.official_team_id = t.id
           AND t.owner_steam_id IS DISTINCT FROM $2::bigint`,
        [clubId, target],
      );
      await this.postgres.query(
        `UPDATE public.clubs SET owner_steam_id = $2::bigint WHERE id = $1::uuid`,
        [clubId, target],
      );
      await this.postgres.query(
        `UPDATE public.club_members SET role = 'admin'
         WHERE club_id = $1::uuid AND steam_id = $2::bigint AND role = 'owner'`,
        [clubId, club.owner_steam_id],
      );
      await this.postgres.query(
        `INSERT INTO public.club_members (club_id, steam_id, role)
         VALUES ($1::uuid, $2::bigint, 'owner')
         ON CONFLICT (club_id, steam_id) DO UPDATE SET role = 'owner'`,
        [clubId, target],
      );
      await this.logActivity(clubId, actorSteamId, "owner_transferred", {
        to: target,
      });
      this.invalidateClanTags();
      return { success: true };
    } catch (err) {
      this.rethrowClubRule(err);
    }
  }

  public async createClubOfficialTeam(clubId: string, actorSteamId: string) {
    const clubs = await this.postgres.query<
      Array<{
        owner_steam_id: string;
        name: string;
        short_name: string | null;
        official_team_id: string | null;
      }>
    >(
      `SELECT owner_steam_id::text, name, short_name, official_team_id::text
       FROM public.clubs WHERE id = $1::uuid`,
      [clubId],
    );
    const club = clubs.at(0);
    if (!club) throw new BadRequestException("Club not found");
    if (
      club.owner_steam_id !== actorSteamId &&
      !(await this.isSiteAdmin(actorSteamId))
    ) {
      throw new ForbiddenException(
        "Only the club owner can set the official team",
      );
    }
    if (club.official_team_id) {
      return { success: true, team_id: club.official_team_id };
    }
    const shortName = (club.short_name || club.name)
      .replace(/\s+/g, "")
      .slice(0, 5);
    try {
      const teams = await this.postgres.query<Array<{ id: string }>>(
        `INSERT INTO public.teams (name, short_name, owner_steam_id)
         VALUES ($1, $2, $3::bigint)
         RETURNING id::text`,
        [club.name, shortName || "CLUB", club.owner_steam_id],
      );
      const teamId = teams.at(0)?.id;
      if (!teamId) throw new BadRequestException("Could not create team");
      await this.postgres.query(
        `UPDATE public.clubs SET official_team_id = $2::uuid WHERE id = $1::uuid`,
        [clubId, teamId],
      );
      await this.logActivity(clubId, actorSteamId, "official_team", {
        team_id: teamId,
      });
      return { success: true, team_id: teamId };
    } catch (err) {
      this.rethrowClubRule(err);
    }
  }

  public async leaveClub(clubId: string, steamId: string) {
    const rows = await this.postgres.query<Array<{ role: string }>>(
      `SELECT role FROM public.club_members
       WHERE club_id = $1::uuid AND steam_id = $2::bigint`,
      [clubId, steamId],
    );
    const membership = rows.at(0);
    if (!membership) throw new BadRequestException("Not a club member");
    if (membership.role === "owner") {
      throw new ForbiddenException("Transfer the club before leaving");
    }
    await this.postgres.query(
      `DELETE FROM public.club_members
       WHERE club_id = $1::uuid AND steam_id = $2::bigint`,
      [clubId, steamId],
    );
    await this.logActivity(clubId, steamId, "member_left", {});
    this.invalidateClanTags();
    return { success: true };
  }

  public async grantPlayerTag(
    actorSteamId: string,
    steamId: string,
    tag: string,
  ) {
    await this.assertSiteAdmin(actorSteamId);
    const normalized = this.normalizeTag(tag);
    await this.postgres.query(
      `INSERT INTO public.player_tags (steam_id, tag, granted_by_steam_id)
       VALUES ($1::bigint, $2, $3::bigint)
       ON CONFLICT (steam_id, tag) DO UPDATE SET
         granted_by_steam_id = EXCLUDED.granted_by_steam_id,
         granted_at = now()`,
      [steamId, normalized, actorSteamId],
    );
    return { success: true };
  }

  public async revokePlayerTag(
    actorSteamId: string,
    steamId: string,
    tag: string,
  ) {
    await this.assertSiteAdmin(actorSteamId);
    await this.postgres.query(
      `DELETE FROM public.player_tags
       WHERE steam_id = $1::bigint AND tag = $2`,
      [steamId, this.normalizeTag(tag)],
    );
    return { success: true };
  }

  public async clanTagMap(steamIds?: string[]): Promise<Map<string, string>> {
    const all = await this.allClanTags();
    if (!steamIds?.length) return all;
    const filtered = new Map<string, string>();
    for (const id of steamIds) {
      const tag = all.get(String(id));
      if (tag) filtered.set(String(id), tag);
    }
    return filtered;
  }

  public async clanTagsPayload() {
    const map = await this.allClanTags();
    return { tags: Object.fromEntries(map) };
  }

  public async acceptClubInvite(inviteId: string, steamId: string) {
    const rows = await this.postgres.query<
      Array<{ club_id: string; steam_id: string }>
    >(
      `SELECT club_id::text, steam_id::text
       FROM public.club_invites WHERE id = $1::uuid`,
      [inviteId],
    );
    const invite = rows.at(0);
    if (!invite) throw new BadRequestException("Invite not found");
    if (invite.steam_id !== steamId)
      throw new ForbiddenException("Invite is for another player");

    await this.assertNotBanned(invite.club_id, steamId);
    await this.assertJoinAllowed(steamId);
    await this.insertMember(invite.club_id, steamId);
    await this.postgres.query(
      `DELETE FROM public.club_invites WHERE id = $1::uuid`,
      [inviteId],
    );
    await this.logActivity(invite.club_id, steamId, "member_joined", {
      via: "invite",
    });
    return { success: true };
  }

  public async redeemClubInviteLink(code: string, steamId: string) {
    const rows = await this.postgres.query<
      Array<{
        id: string;
        club_id: string;
        max_uses: number | null;
        uses: number;
        expires_at: string | null;
        revoked_at: string | null;
        bypass_requirements: boolean;
      }>
    >(
      `SELECT id::text, club_id::text, max_uses, uses, expires_at::text, revoked_at::text, bypass_requirements
       FROM public.club_invite_links
       WHERE code = $1`,
      [code.trim()],
    );
    const link = rows.at(0);
    if (!link || link.revoked_at)
      throw new BadRequestException("Invite link invalid");
    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now())
      throw new BadRequestException("Invite link expired");
    if (link.max_uses != null && link.uses >= link.max_uses)
      throw new BadRequestException("Invite link exhausted");

    await this.assertNotBanned(link.club_id, steamId);
    await this.assertJoinAllowed(steamId);
    if (!link.bypass_requirements)
      await this.assertJoinRequirements(link.club_id, steamId);

    await this.insertMember(link.club_id, steamId);
    await this.postgres.query(
      `UPDATE public.club_invite_links SET uses = uses + 1 WHERE id = $1::uuid`,
      [link.id],
    );
    await this.logActivity(link.club_id, steamId, "member_joined", {
      via: "invite_link",
    });
    return { success: true, club_id: link.club_id };
  }

  public async createClubInviteLink(
    clubId: string,
    steamId: string,
    opts: {
      max_uses?: number | null;
      expires_hours?: number | null;
      bypass_requirements?: boolean;
    },
  ) {
    await this.assertCanManage(clubId, steamId);
    const code = randomBytes(8).toString("base64url");
    const expires =
      opts.expires_hours && opts.expires_hours > 0
        ? new Date(Date.now() + opts.expires_hours * 3600_000).toISOString()
        : null;
    const rows = await this.postgres.query<Array<{ id: string; code: string }>>(
      `INSERT INTO public.club_invite_links
         (club_id, code, created_by_steam_id, max_uses, expires_at, bypass_requirements)
       VALUES ($1::uuid, $2, $3::bigint, $4, $5, $6)
       RETURNING id::text, code`,
      [
        clubId,
        code,
        steamId,
        opts.max_uses ?? null,
        expires,
        !!opts.bypass_requirements,
      ],
    );
    return { success: true, ...rows.at(0) };
  }

  public async reviewClubJoinRequest(
    requestId: string,
    steamId: string,
    accept: boolean,
  ) {
    const rows = await this.postgres.query<
      Array<{ club_id: string; steam_id: string; status: string }>
    >(
      `SELECT club_id::text, steam_id::text, status
       FROM public.club_join_requests WHERE id = $1::uuid`,
      [requestId],
    );
    const req = rows.at(0);
    if (!req) throw new BadRequestException("Request not found");
    if (req.status !== "pending")
      throw new BadRequestException("Request already reviewed");
    await this.assertCanManage(req.club_id, steamId);

    if (accept) {
      await this.assertNotBanned(req.club_id, req.steam_id);
      await this.assertJoinAllowed(req.steam_id);
      await this.insertMember(req.club_id, req.steam_id);
      await this.logActivity(req.club_id, req.steam_id, "member_joined", {
        via: "request",
      });
    }

    await this.postgres.query(
      `UPDATE public.club_join_requests
       SET status = $2, reviewed_by_steam_id = $3::bigint, reviewed_at = now()
       WHERE id = $1::uuid`,
      [requestId, accept ? "accepted" : "denied", steamId],
    );
    return { success: true };
  }

  public async requestClubJoin(
    clubId: string,
    steamId: string,
    message?: string | null,
  ) {
    const clubs = await this.postgres.query<Array<{ join_mode: string }>>(
      `SELECT join_mode FROM public.clubs WHERE id = $1::uuid`,
      [clubId],
    );
    const club = clubs.at(0);
    if (!club) throw new BadRequestException("Club not found");
    if (club.join_mode !== "request") {
      throw new BadRequestException("Club does not take join requests");
    }
    if (await this.isMember(clubId, steamId)) {
      throw new BadRequestException("Already a club member");
    }
    await this.assertNotBanned(clubId, steamId);
    await this.assertJoinAllowed(steamId);
    await this.assertJoinRequirements(clubId, steamId);
    try {
      await this.postgres.query(
        `INSERT INTO public.club_join_requests (club_id, steam_id, message, status)
         VALUES ($1::uuid, $2::bigint, $3, 'pending')
         ON CONFLICT (club_id, steam_id) DO UPDATE SET
           message = EXCLUDED.message,
           status = 'pending',
           reviewed_by_steam_id = NULL,
           reviewed_at = NULL,
           created_at = CASE
             WHEN public.club_join_requests.status = 'pending'
             THEN public.club_join_requests.created_at
             ELSE now()
           END`,
        [clubId, steamId, (message || "").trim()],
      );
    } catch (err) {
      this.rethrowClubRule(err);
    }
    return { success: true };
  }

  public async previewClubLeave(clubId: string, steamId: string) {
    if (!(await this.isMember(clubId, steamId))) {
      throw new BadRequestException("Not a club member");
    }
    const rows = await this.postgres.query<
      Array<{ blocked_until: string; leave_count: number }>
    >(
      `SELECT public.preview_club_leave_block($1::bigint)::text AS blocked_until,
              public.club_leave_next_count($1::bigint) AS leave_count`,
      [steamId],
    );
    const row = rows.at(0);
    return {
      blocked_until: row?.blocked_until || "",
      leave_count: row?.leave_count ?? 1,
    };
  }

  public async joinClubOpen(clubId: string, steamId: string) {
    const clubs = await this.postgres.query<Array<{ join_mode: string }>>(
      `SELECT join_mode FROM public.clubs WHERE id = $1::uuid`,
      [clubId],
    );
    const club = clubs.at(0);
    if (!club) throw new BadRequestException("Club not found");
    if (club.join_mode !== "open")
      throw new BadRequestException("Club is not open join");
    await this.assertNotBanned(clubId, steamId);
    await this.assertJoinAllowed(steamId);
    await this.assertJoinRequirements(clubId, steamId);
    await this.insertMember(clubId, steamId);
    await this.logActivity(clubId, steamId, "member_joined", { via: "open" });
    return { success: true };
  }

  public async setPrimaryClub(clubId: string, steamId: string) {
    const ok = await this.postgres.query<Array<{ ok: boolean }>>(
      `SELECT true AS ok FROM public.club_members
       WHERE club_id = $1::uuid AND steam_id = $2::bigint`,
      [clubId, steamId],
    );
    if (!ok.length) throw new ForbiddenException("Not a club member");
    await this.postgres.query(
      `UPDATE public.club_members SET is_primary = (club_id = $1::uuid)
       WHERE steam_id = $2::bigint`,
      [clubId, steamId],
    );
    return { success: true };
  }

  public async joinClubQueue(queueId: string, steamId: string) {
    const flag = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings
       WHERE name = 'public.clubs_queues_enabled' LIMIT 1`,
    );
    if ((flag.at(0)?.value ?? "false") !== "true") {
      throw new BadRequestException("Club queues are disabled");
    }

    const q = await this.postgres.query<
      Array<{ club_id: string; enabled: boolean; min_players: number }>
    >(
      `SELECT club_id::text, enabled, min_players FROM public.club_queues WHERE id = $1::uuid`,
      [queueId],
    );
    const queue = q.at(0);
    if (!queue || !queue.enabled)
      throw new BadRequestException("Queue unavailable");
    if (!(await this.isMember(queue.club_id, steamId)))
      throw new ForbiddenException("Must be a club member");
    await this.postgres.query(
      `INSERT INTO public.club_queue_players (queue_id, steam_id)
       VALUES ($1::uuid, $2::bigint)
       ON CONFLICT DO NOTHING`,
      [queueId, steamId],
    );
    const count = await this.tryStartClubQueue(queueId);
    return { success: true, queued: count };
  }

  public async leaveClubQueue(queueId: string, steamId: string) {
    await this.postgres.query(
      `DELETE FROM public.club_queue_players
       WHERE queue_id = $1::uuid AND steam_id = $2::bigint`,
      [queueId, steamId],
    );
    return { success: true };
  }

  /** When enough players are waiting, create an in-house match via MatchAssistant. */
  public async tryStartClubQueue(queueId: string): Promise<number> {
    const q = await this.postgres.query<
      Array<{
        min_players: number;
        club_id: string;
        name: string;
        team_size: number;
        region: string | null;
      }>
    >(
      `SELECT min_players, club_id::text, name, team_size, region
       FROM public.club_queues WHERE id = $1::uuid`,
      [queueId],
    );
    const queue = q.at(0);
    if (!queue) return 0;
    const players = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text FROM public.club_queue_players
       WHERE queue_id = $1::uuid ORDER BY joined_at ASC`,
      [queueId],
    );
    if (players.length < queue.min_players) return players.length;

    const taken = players.slice(0, queue.min_players).map((p) => p.steam_id);
    const teamSize = Math.max(1, queue.team_size || 5);
    const team1 = taken.slice(0, teamSize);
    const team2 = taken.slice(teamSize, teamSize * 2);
    if (team1.length < teamSize || team2.length < teamSize) {
      return players.length;
    }

    await this.postgres.query(
      `DELETE FROM public.club_queue_players
       WHERE queue_id = $1::uuid AND steam_id = ANY($2::bigint[])`,
      [queueId, taken],
    );

    try {
      const match = await this.createClubInHouseMatch(
        team1,
        team2,
        queue.region,
      );

      await this.logActivity(queue.club_id, taken[0], "queue_match_created", {
        queue_id: queueId,
        queue_name: queue.name,
        match_id: match.id,
        steam_ids: taken,
      });
      this.logger.log(
        `Club queue ${queueId} started match ${match.id} with ${taken.length} players`,
      );
    } catch (err) {
      this.logger.error(
        `Club queue match create failed queue=${queueId}: ${err}`,
      );
      for (const steamId of taken) {
        await this.postgres.query(
          `INSERT INTO public.club_queue_players (queue_id, steam_id)
           VALUES ($1::uuid, $2::bigint) ON CONFLICT DO NOTHING`,
          [queueId, steamId],
        );
      }
      throw err;
    }

    return players.length - taken.length;
  }

  /** Create a Competitive in-house match without importing MatchesModule (avoids cycles). */
  private async createClubInHouseMatch(
    team1: string[],
    team2: string[],
    region?: string | null,
  ) {
    const pools = await this.hasura.query({
      map_pools: {
        __args: {
          where: { type: { _eq: "Competitive" }, enabled: { _eq: true } },
          order_by: [{ seed: "desc" as const }],
          limit: 1,
        },
        id: true,
      },
    });
    const mapPoolId = pools.map_pools?.at(0)?.id;
    if (!mapPoolId) {
      throw new BadRequestException("No Competitive map pool configured");
    }

    const { insert_matches_one: match } = await this.hasura.mutation({
      insert_matches_one: {
        __args: {
          object: {
            region: region || undefined,
            options: {
              data: {
                map_pool_id: mapPoolId,
                map_veto: true,
                mr: 12,
                type: "Competitive",
                best_of: 1,
                overtime: true,
                knife_round: true,
                region_veto: !region,
                timeout_setting: "Admin",
              },
            },
          },
        },
        id: true,
        lineup_1_id: true,
        lineup_2_id: true,
      },
    });
    if (!match?.id)
      throw new BadRequestException("Failed to create club match");

    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: [
            ...team1.map((steam_id) => ({
              steam_id,
              match_lineup_id: match.lineup_1_id,
            })),
            ...team2.map((steam_id) => ({
              steam_id,
              match_lineup_id: match.lineup_2_id,
            })),
          ],
        },
        __typename: true,
      },
    });

    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: { id: match.id },
          _set: { status: "Live" },
        },
        id: true,
      },
    });

    return match;
  }

  public async addClubPartyGuest(
    partyId: string,
    leaderSteamId: string,
    guestSteamId: string,
  ) {
    const parties = await this.postgres.query<
      Array<{ leader_steam_id: string; club_id: string }>
    >(
      `SELECT leader_steam_id::text, club_id::text
       FROM public.club_parties WHERE id = $1::uuid`,
      [partyId],
    );
    const party = parties.at(0);
    if (!party) throw new BadRequestException("Party not found");
    if (party.leader_steam_id !== leaderSteamId)
      throw new ForbiddenException("Only the party leader can add guests");
    await this.postgres.query(
      `INSERT INTO public.club_party_members (party_id, steam_id, is_guest)
       VALUES ($1::uuid, $2::bigint, true)
       ON CONFLICT DO NOTHING`,
      [partyId, guestSteamId],
    );
    return { success: true };
  }

  public async registerClubClash(
    eventId: string,
    clubId: string,
    steamId: string,
  ) {
    const events = await this.postgres.query<
      Array<{ locked: boolean; starts_at: string; ends_at: string }>
    >(
      `SELECT locked, starts_at::text, ends_at::text
       FROM public.club_clash_events WHERE id = $1::uuid`,
      [eventId],
    );
    const event = events.at(0);
    if (!event) throw new BadRequestException("Event not found");
    if (event.locked) throw new BadRequestException("Registration locked");

    const primary = await this.postgres.query<Array<{ club_id: string }>>(
      `SELECT club_id::text FROM public.club_members
       WHERE steam_id = $1::bigint AND is_primary = true`,
      [steamId],
    );
    const primaryClub = primary.at(0)?.club_id;
    if (!primaryClub || primaryClub !== clubId)
      throw new ForbiddenException("Set this club as primary to represent it");

    await this.postgres.query(
      `INSERT INTO public.club_clash_players (event_id, steam_id, club_id)
       VALUES ($1::uuid, $2::bigint, $3::uuid)
       ON CONFLICT (event_id, steam_id) DO UPDATE SET club_id = EXCLUDED.club_id`,
      [eventId, steamId, clubId],
    );
    await this.postgres.query(
      `INSERT INTO public.club_clash_entries (event_id, club_id, points)
       VALUES ($1::uuid, $2::uuid, 0)
       ON CONFLICT DO NOTHING`,
      [eventId, clubId],
    );
    return { success: true };
  }

  /** Award flat points on ranked match end for members with a primary club. */
  public async applyMatchPoints(steamId: string, won: boolean): Promise<void> {
    try {
      await this.postgres.query(
        `WITH primary_club AS (
           SELECT club_id FROM public.club_members
           WHERE steam_id = $1::bigint AND is_primary = true
           LIMIT 1
         ),
         lbs AS (
           SELECT l.id, l.points_win, l.points_loss, l.starting_points
           FROM public.club_leaderboards l
           JOIN primary_club pc ON pc.club_id = l.club_id
           WHERE l.frozen = false
             AND (l.starts_at IS NULL OR l.starts_at <= now())
             AND (l.ends_at IS NULL OR l.ends_at > now())
         )
         INSERT INTO public.club_leaderboard_entries
           (leaderboard_id, steam_id, points, wins, losses, streak, updated_at)
         SELECT
           lbs.id,
           $1::bigint,
           GREATEST(0, lbs.starting_points + CASE WHEN $2 THEN lbs.points_win ELSE lbs.points_loss END),
           CASE WHEN $2 THEN 1 ELSE 0 END,
           CASE WHEN $2 THEN 0 ELSE 1 END,
           CASE WHEN $2 THEN 1 ELSE -1 END,
           now()
         FROM lbs
         ON CONFLICT (leaderboard_id, steam_id) DO UPDATE SET
           points = GREATEST(0, public.club_leaderboard_entries.points + (
             SELECT CASE WHEN $2 THEN points_win ELSE points_loss END
             FROM public.club_leaderboards WHERE id = public.club_leaderboard_entries.leaderboard_id
           )),
           wins = public.club_leaderboard_entries.wins + CASE WHEN $2 THEN 1 ELSE 0 END,
           losses = public.club_leaderboard_entries.losses + CASE WHEN $2 THEN 0 ELSE 1 END,
           streak = CASE
             WHEN $2 AND public.club_leaderboard_entries.streak >= 0
               THEN public.club_leaderboard_entries.streak + 1
             WHEN $2 THEN 1
             WHEN public.club_leaderboard_entries.streak <= 0
               THEN public.club_leaderboard_entries.streak - 1
             ELSE -1
           END,
           updated_at = now()`,
        [steamId, won],
      );
    } catch (err) {
      this.logger.warn(
        `club leaderboard points failed steam=${steamId}: ${err}`,
      );
    }
  }

  private async insertMember(clubId: string, steamId: string) {
    try {
      await this.postgres.query(
        `INSERT INTO public.club_members (club_id, steam_id, role)
         VALUES ($1::uuid, $2::bigint, 'member')
         ON CONFLICT DO NOTHING`,
        [clubId, steamId],
      );
      this.invalidateClanTags();
    } catch (err) {
      this.rethrowClubRule(err);
    }
  }

  private async allClanTags(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.clanTagCache && now - this.clanTagCache.at < CLAN_TAG_CACHE_MS) {
      return this.clanTagCache.map;
    }
    const rows = await this.postgres.query<
      Array<{ steam_id: string; tag: string }>
    >(
      `SELECT DISTINCT ON (m.steam_id)
         m.steam_id::text AS steam_id,
         public.club_clan_tag(c.short_name, c.name) AS tag
       FROM public.club_members m
       JOIN public.clubs c ON c.id = m.club_id
       WHERE public.club_clan_tag(c.short_name, c.name) <> ''
       ORDER BY m.steam_id, m.is_primary DESC, m.joined_at ASC`,
    );
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.tag) map.set(row.steam_id, row.tag);
    }
    this.clanTagCache = { at: now, map };
    return map;
  }

  private invalidateClanTags() {
    this.clanTagCache = null;
  }

  private async assertJoinAllowed(steamId: string) {
    const rows = await this.postgres.query<Array<{ blocked_until: string }>>(
      `SELECT blocked_until::text
       FROM public.club_leave_cooldowns
       WHERE steam_id = $1::bigint AND blocked_until > now()`,
      [steamId],
    );
    const until = rows.at(0)?.blocked_until;
    if (until) {
      throw new ForbiddenException(`Cannot join a club until ${until}`);
    }
  }

  private async assertCanOwnClub(steamId: string) {
    const rows = await this.postgres.query<Array<{ ok: boolean }>>(
      `SELECT true AS ok WHERE public.player_can_own_club($1::bigint)`,
      [steamId],
    );
    if (!rows.length) {
      throw new ForbiddenException(
        "OwnClub tag required to create or own a club",
      );
    }
  }

  private async isSiteAdmin(steamId: string) {
    const rows = await this.postgres.query<Array<{ role: string }>>(
      `SELECT role FROM public.players WHERE steam_id = $1::bigint`,
      [steamId],
    );
    return rows.at(0)?.role === "administrator";
  }

  private async assertSiteAdmin(steamId: string) {
    if (!(await this.isSiteAdmin(steamId))) {
      throw new ForbiddenException("Site administrator required");
    }
  }

  private normalizeTag(tag: string) {
    const value = (tag || "").trim();
    if (!value) throw new BadRequestException("Tag is required");
    if (value !== OWN_CLUB_TAG) {
      throw new BadRequestException("Unsupported player tag");
    }
    return value;
  }

  private rethrowClubRule(err: unknown): never {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("own_club_tag_required")) {
      throw new ForbiddenException(
        "OwnClub tag required to create or own a club",
      );
    }
    const cooldown = msg.match(/club_join_cooldown:([^\s]+(?:\s[^\s]+)?)/);
    if (cooldown?.[1] || msg.includes("club_join_cooldown")) {
      const until = cooldown?.[1]?.trim() || "";
      throw new ForbiddenException(
        until ? `Cannot join a club until ${until}` : "Cannot join a club yet",
      );
    }
    throw err;
  }

  public async setClubMemberVip(
    clubId: string,
    actorSteamId: string,
    targetSteamId: string,
    isVip: boolean,
  ) {
    await this.assertCanManage(clubId, actorSteamId);
    const updated = await this.postgres.query<Array<{ steam_id: string }>>(
      `UPDATE public.club_members
          SET is_vip = $3
        WHERE club_id = $1::uuid AND steam_id = $2::bigint
        RETURNING steam_id::text`,
      [clubId, targetSteamId, isVip],
    );
    if (!updated.length) throw new BadRequestException("Member not found");
    return { success: true };
  }

  public async listClubServers(clubId: string, user?: User | null) {
    this.assertUuid(clubId);
    const servers = await this.postgres.query<
      Array<{
        id: string;
        label: string | null;
        section_mode: string | null;
        connected: boolean;
        enabled: boolean;
        link: string | null;
      }>
    >(
      `SELECT s.id::text AS id,
              s.label,
              s.section_mode,
              s.connected,
              s.enabled,
              public.get_server_connection_link(
                s, '{"x-hasura-role":"guest"}'::json
              ) AS link
         FROM public.servers s
        WHERE s.club_id = $1::uuid
        ORDER BY s.label ASC NULLS LAST`,
      [clubId],
    );

    const manage = await this.canManageClubServers(clubId, user);
    if (!manage) return { servers, manage: false, available: [] };

    const siteAdmin = this.isSiteAdmin(user);
    const available = siteAdmin
      ? await this.postgres.query<
          Array<{
            id: string;
            label: string | null;
            section_mode: string | null;
          }>
        >(
          `SELECT s.id::text AS id, s.label, s.section_mode
             FROM public.servers s
            WHERE s.section_mode IS NOT NULL
              AND s.club_id IS NULL
            ORDER BY s.label ASC NULLS LAST
            LIMIT 100`,
        )
      : await this.postgres.query<
          Array<{
            id: string;
            label: string | null;
            section_mode: string | null;
          }>
        >(
          `SELECT s.id::text AS id,
                  COALESCE(NULLIF(h.label, ''), s.label) AS label,
                  s.section_mode
             FROM public.hosted_servers h
             JOIN public.servers s ON s.id = h.server_id
            WHERE h.owner_steam_id = $1::bigint
              AND s.club_id IS NULL
              AND s.section_mode IS NOT NULL
            ORDER BY label ASC NULLS LAST`,
          [String(user?.steam_id || "")],
        );

    return { servers, manage: true, available };
  }

  public async attachClubServer(clubId: string, serverId: string, user: User) {
    await this.assertClubServerStaff(clubId, user);
    this.assertUuid(serverId);
    const updated = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.servers s
          SET club_id = $1::uuid
        WHERE s.id = $2::uuid
          AND s.club_id IS NULL
          AND s.section_mode IS NOT NULL
          AND (
            $3::boolean
            OR EXISTS (
              SELECT 1 FROM public.hosted_servers h
               WHERE h.server_id = s.id
                 AND h.owner_steam_id = $4::bigint
            )
          )
        RETURNING s.id::text`,
      [clubId, serverId, this.isSiteAdmin(user), String(user.steam_id)],
    );
    if (!updated.length) {
      throw new ForbiddenException("That server cannot be added to this club");
    }
    return { success: true };
  }

  public async detachClubServer(clubId: string, serverId: string, user: User) {
    await this.assertClubServerStaff(clubId, user);
    this.assertUuid(serverId);
    const updated = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.servers
          SET club_id = NULL
        WHERE id = $2::uuid
          AND club_id = $1::uuid
        RETURNING id::text`,
      [clubId, serverId],
    );
    if (!updated.length)
      throw new ForbiddenException("Server is not on this club");
    return { success: true };
  }

  public async assertClubServerMap(
    clubId: string,
    serverId: string,
    user: User,
  ) {
    await this.assertClubServerStaff(clubId, user);
    this.assertUuid(serverId);
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text FROM public.servers
        WHERE id = $2::uuid AND club_id = $1::uuid`,
      [clubId, serverId],
    );
    if (!rows.length) {
      throw new ForbiddenException("Server is not on this club");
    }
  }

  public async liveChallenges(
    mode: string,
    steamId?: string,
    serverId?: string,
  ) {
    const clubId = await this.clubIdForServer(serverId);
    if (!clubId) return { challenges: [] };
    const section = this.normalizeMode(mode);
    const rows = await this.postgres.query<Array<Record<string, unknown>>>(
      `SELECT ch.id::text AS id,
              ch.club_id::text AS club_id,
              ch.prize_ypoints,
              ch.prize_other,
              ch.prize_scope,
              ch.audience,
              ch.ends_at,
              cat.title,
              cat.title_fa,
              cat.weapon,
              cat.metric,
              cat.target,
              cat.server_mode,
              cat.difficulty,
              c.slug,
              c.name,
              c.short_name,
              COALESCE(p.progress, 0) AS progress,
              p.completed_at
         FROM public.club_challenges ch
         JOIN public.club_challenge_catalog cat ON cat.id = ch.catalog_id
         JOIN public.clubs c ON c.id = ch.club_id
         LEFT JOIN public.club_challenge_progress p
           ON p.challenge_id = ch.id AND p.steam_id = NULLIF($2, '')::bigint
        WHERE ch.active
          AND ch.ends_at > now()
          AND cat.server_mode = $1
          AND ch.club_id = $3::uuid
          AND public.club_challenge_is_visible(
            ch,
            json_build_object('x-hasura-user-id', NULLIF($2, ''))
          )
        ORDER BY cat.sort_order ASC
        LIMIT 80`,
      [section, steamId || "", clubId],
    );
    return { challenges: rows };
  }

  public async recordChallengeEvent(input: {
    mode: string;
    steam_id: string;
    server_id?: string | null;
    weapon?: string | null;
    noscope?: boolean;
    headshot?: boolean;
    metric?: string | null;
    amount?: number;
  }) {
    const steamId = String(input.steam_id || "").trim();
    if (!steamId) throw new BadRequestException("steam_id is required");
    const clubId = await this.clubIdForServer(input.server_id);
    if (!clubId) return { progress: [] };
    const mode = this.normalizeMode(input.mode);
    const extra = String(input.metric || "").trim();
    const rawAmount = Number(input.amount);
    const amount =
      Number.isFinite(rawAmount) && rawAmount > 0
        ? Math.floor(rawAmount)
        : extra === "damage"
          ? 0
          : 1;
    if (amount <= 0) return { progress: [] };
    const metrics = extra
      ? [extra]
      : [
          "kills",
          ...(input.headshot ? ["headshots"] : []),
          ...(input.noscope ? ["noscope"] : []),
        ];
    if (!(await this.hasLiveChallengeMetrics(mode, metrics, clubId))) {
      return { progress: [] };
    }
    const weapon = this.normalizeWeapon(input.weapon);

    const matches = await this.postgres.query<
      Array<{
        id: string;
        club_id: string;
        prize_ypoints: number | null;
        prize_scope: string;
        audience: string;
        title: string;
        title_fa: string;
        target: number;
        metric: string;
      }>
    >(
      `SELECT ch.id::text AS id,
              ch.club_id::text AS club_id,
              ch.prize_ypoints,
              ch.prize_scope,
              ch.audience,
              cat.title,
              cat.title_fa,
              cat.target,
              cat.metric
         FROM public.club_challenges ch
         JOIN public.club_challenge_catalog cat ON cat.id = ch.catalog_id
        WHERE ch.active
          AND ch.ends_at > now()
          AND cat.server_mode = $1
          AND cat.metric = ANY($2::text[])
          AND (cat.weapon = '' OR regexp_replace(cat.weapon, '^weapon_', '') = $3)
          AND ch.club_id = $5::uuid
          AND public.club_challenge_is_visible(
            ch,
            json_build_object('x-hasura-user-id', $4)
          )`,
      [mode, metrics, weapon, steamId, clubId],
    );

    const progress: Array<{
      id: string;
      title: string;
      title_fa: string;
      current: number;
      target: number;
      completed: boolean;
      just_completed: boolean;
    }> = [];

    for (const row of matches) {
      const before = await this.postgres.query<
        Array<{ progress: number; completed_at: string | null }>
      >(
        `SELECT progress, completed_at::text
           FROM public.club_challenge_progress
          WHERE challenge_id = $1::uuid AND steam_id = $2::bigint`,
        [row.id, steamId],
      );
      const alreadyDone = !!before.at(0)?.completed_at;
      const updated = await this.postgres.query<
        Array<{ progress: number; completed_at: string | null }>
      >(
        `INSERT INTO public.club_challenge_progress
           (challenge_id, steam_id, progress, completed_at, updated_at)
         VALUES (
           $1::uuid, $2::bigint, LEAST($3, $4),
           CASE WHEN $4 >= $3 THEN now() ELSE NULL END, now()
         )
         ON CONFLICT (challenge_id, steam_id) DO UPDATE SET
           progress = CASE
             WHEN club_challenge_progress.completed_at IS NOT NULL
             THEN club_challenge_progress.progress
             ELSE LEAST($3, club_challenge_progress.progress + EXCLUDED.progress)
           END,
           completed_at = CASE
             WHEN club_challenge_progress.completed_at IS NOT NULL
             THEN club_challenge_progress.completed_at
             WHEN club_challenge_progress.progress + EXCLUDED.progress >= $3
             THEN now()
             ELSE NULL
           END,
           updated_at = now()
         RETURNING progress, completed_at::text`,
        [row.id, steamId, row.target, amount],
      );
      const after = updated.at(0);
      const current = Number(after?.progress ?? 0);
      const completed = !!after?.completed_at;
      const justCompleted = completed && !alreadyDone;
      if (justCompleted && row.prize_ypoints && row.prize_ypoints > 0) {
        const canPrize =
          row.prize_scope === "site" ||
          (await this.isMember(row.club_id, steamId));
        if (canPrize) {
          try {
            await this.ypoint.credit({
              steamId,
              amount: row.prize_ypoints,
              reason: `Club challenge: ${row.title}`,
              refType: "club_challenge",
              refId: row.id,
            });
          } catch (err) {
            this.logger.warn(
              `club challenge prize failed id=${row.id} steam=${steamId}: ${String(err)}`,
            );
          }
        }
      }
      progress.push({
        id: row.id,
        title: row.title,
        title_fa: row.title_fa,
        current,
        target: row.target,
        completed,
        just_completed: justCompleted && current >= row.target,
      });
    }

    return { progress };
  }

  private matchChallengeMode = new Map<
    string,
    { mode: "competitive" | "scrim" | null; at: number }
  >();
  private liveMetricCache = new Map<string, { yes: boolean; at: number }>();

  private async hasLiveChallengeMetrics(
    mode: string,
    metrics: string[],
    clubId: string,
  ) {
    const key = `${clubId}:${mode}:${metrics.slice().sort().join(",")}`;
    const hit = this.liveMetricCache.get(key);
    if (hit && Date.now() - hit.at < 15_000) return hit.yes;
    const rows = await this.postgres.query<Array<{ ok: boolean }>>(
      `SELECT true AS ok
         FROM public.club_challenges ch
         JOIN public.club_challenge_catalog cat ON cat.id = ch.catalog_id
        WHERE ch.active
          AND ch.ends_at > now()
          AND ch.club_id = $3::uuid
          AND cat.server_mode = $1
          AND cat.metric = ANY($2::text[])
        LIMIT 1`,
      [mode, metrics, clubId],
    );
    const yes = rows.length > 0;
    this.liveMetricCache.set(key, { yes, at: Date.now() });
    return yes;
  }

  public async recordMatchChallengeEvent(
    matchId: string,
    input: {
      steam_id: string;
      weapon?: string | null;
      noscope?: boolean;
      headshot?: boolean;
      metric?: string | null;
      amount?: number;
    },
  ) {
    const mode = await this.resolveMatchChallengeMode(matchId);
    if (!mode) return { progress: [] };
    const serverId = await this.serverIdForMatch(matchId);
    if (!serverId) return { progress: [] };
    const steamId = String(input.steam_id || "").trim();
    if (!steamId) return { progress: [] };
    try {
      return await this.recordChallengeEvent({
        ...input,
        mode,
        steam_id: steamId,
        server_id: serverId,
      });
    } catch (err) {
      this.logger.warn(
        `club match challenge failed match=${matchId} steam=${steamId}: ${String(err)}`,
      );
      return { progress: [] };
    }
  }

  private async resolveMatchChallengeMode(
    matchId: string,
  ): Promise<"competitive" | "scrim" | null> {
    const id = String(matchId || "").trim();
    if (!id) return null;
    const hit = this.matchChallengeMode.get(id);
    if (hit && Date.now() - hit.at < 60_000) return hit.mode;
    const rows = await this.postgres.query<
      Array<{ type: string | null; is_scrim: boolean }>
    >(
      `SELECT o.type,
              EXISTS (
                SELECT 1 FROM public.team_scrim_requests r
                 WHERE r.match_id = m.id
              ) AS is_scrim
         FROM public.matches m
         JOIN public.match_options o ON o.id = m.match_options_id
        WHERE m.id = $1::uuid`,
      [id],
    );
    const row = rows.at(0);
    let mode: "competitive" | "scrim" | null = null;
    if (row?.is_scrim) mode = "scrim";
    else if (String(row?.type || "").toLowerCase() === "competitive") {
      mode = "competitive";
    }
    this.matchChallengeMode.set(id, { mode, at: Date.now() });
    return mode;
  }

  private normalizeMode(mode: string) {
    const value = String(mode || "")
      .trim()
      .toLowerCase();
    if (value === "aim") return "dm";
    if (value === "comp") return "competitive";
    if (
      ["duels", "dm", "awp", "2x2", "bhop", "competitive", "scrim"].includes(
        value,
      )
    ) {
      return value;
    }
    throw new BadRequestException("Unknown server mode");
  }

  private normalizeWeapon(weapon?: string | null) {
    return String(weapon || "")
      .trim()
      .toLowerCase()
      .replace(/^weapon_/, "");
  }

  private assertUuid(value: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        String(value || ""),
      )
    ) {
      throw new BadRequestException("Invalid id");
    }
  }

  private isSiteAdmin(user?: User | null) {
    return String(user?.role || "") === "administrator";
  }

  private async canManageClubServers(clubId: string, user?: User | null) {
    if (!user?.steam_id) return false;
    if (this.isSiteAdmin(user)) return true;
    const rows = await this.postgres.query<Array<{ ok: boolean }>>(
      `SELECT true AS ok FROM public.club_members
        WHERE club_id = $1::uuid AND steam_id = $2::bigint
          AND role IN ('owner', 'admin')`,
      [clubId, String(user.steam_id)],
    );
    return rows.length > 0;
  }

  private async assertClubServerStaff(clubId: string, user: User) {
    this.assertUuid(clubId);
    if (!(await this.canManageClubServers(clubId, user))) {
      throw new ForbiddenException("Club admin required");
    }
  }

  private async clubIdForServer(serverId?: string | null) {
    const id = String(serverId || "").trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      return null;
    }
    const rows = await this.postgres.query<Array<{ club_id: string | null }>>(
      `SELECT club_id::text FROM public.servers WHERE id = $1::uuid`,
      [id],
    );
    return rows[0]?.club_id ?? null;
  }

  private async serverIdForMatch(matchId: string) {
    const id = String(matchId || "").trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      return null;
    }
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text FROM public.servers
        WHERE reserved_by_match_id = $1::uuid
        LIMIT 1`,
      [id],
    );
    return rows[0]?.id ?? null;
  }

  private async assertCanManage(clubId: string, steamId: string) {
    const rows = await this.postgres.query<Array<{ ok: boolean }>>(
      `SELECT true AS ok FROM public.club_members
       WHERE club_id = $1::uuid AND steam_id = $2::bigint
         AND role IN ('owner', 'admin')`,
      [clubId, steamId],
    );
    if (!rows.length) throw new ForbiddenException("Club admin required");
  }

  private async isMember(clubId: string, steamId: string) {
    const rows = await this.postgres.query<Array<{ ok: boolean }>>(
      `SELECT true AS ok FROM public.club_members
       WHERE club_id = $1::uuid AND steam_id = $2::bigint`,
      [clubId, steamId],
    );
    return rows.length > 0;
  }

  private async assertNotBanned(clubId: string, steamId: string) {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text FROM public.club_bans
       WHERE club_id = $1::uuid AND steam_id = $2::bigint`,
      [clubId, steamId],
    );
    if (rows.length) throw new ForbiddenException("Banned from this club");
  }

  private async assertJoinRequirements(clubId: string, steamId: string) {
    const clubs = await this.postgres.query<
      Array<{ min_elo: number | null; min_faceit_level: number | null }>
    >(
      `SELECT min_elo, min_faceit_level FROM public.clubs WHERE id = $1::uuid`,
      [clubId],
    );
    const club = clubs.at(0);
    if (!club) return;
    if (club.min_elo == null && club.min_faceit_level == null) return;

    const players = await this.postgres.query<
      Array<{ elo: number | null; faceit_level: number | null }>
    >(
      `SELECT p.faceit_elo AS elo, p.faceit_skill_level AS faceit_level
       FROM public.players p WHERE p.steam_id = $1::bigint`,
      [steamId],
    );
    const p = players.at(0);
    if (club.min_elo != null && (p?.elo ?? 0) < club.min_elo)
      throw new ForbiddenException(`Requires Elo ≥ ${club.min_elo}`);
    if (
      club.min_faceit_level != null &&
      (p?.faceit_level ?? 0) < club.min_faceit_level
    )
      throw new ForbiddenException(
        `Requires FACEIT level ≥ ${club.min_faceit_level}`,
      );
  }

  private async logActivity(
    clubId: string,
    actorSteamId: string | null,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    await this.postgres.query(
      `INSERT INTO public.club_activity (club_id, actor_steam_id, kind, payload)
       VALUES ($1::uuid, $2::bigint, $3, $4::jsonb)`,
      [clubId, actorSteamId, kind, JSON.stringify(payload)],
    );
  }
}
