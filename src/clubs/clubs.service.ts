import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { PostgresService } from "../postgres/postgres.service";
import { HasuraService } from "../hasura/hasura.service";

@Injectable()
export class ClubsService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {}

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
    await this.postgres.query(
      `INSERT INTO public.club_members (club_id, steam_id, role)
       VALUES ($1::uuid, $2::bigint, 'member')
       ON CONFLICT DO NOTHING`,
      [invite.club_id, steamId],
    );
    await this.postgres.query(`DELETE FROM public.club_invites WHERE id = $1::uuid`, [
      inviteId,
    ]);
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
    if (!link.bypass_requirements)
      await this.assertJoinRequirements(link.club_id, steamId);

    await this.postgres.query(
      `INSERT INTO public.club_members (club_id, steam_id, role)
       VALUES ($1::uuid, $2::bigint, 'member')
       ON CONFLICT DO NOTHING`,
      [link.club_id, steamId],
    );
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
      await this.postgres.query(
        `INSERT INTO public.club_members (club_id, steam_id, role)
         VALUES ($1::uuid, $2::bigint, 'member')
         ON CONFLICT DO NOTHING`,
        [req.club_id, req.steam_id],
      );
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

  public async joinClubOpen(clubId: string, steamId: string) {
    const clubs = await this.postgres.query<
      Array<{ join_mode: string }>
    >(`SELECT join_mode FROM public.clubs WHERE id = $1::uuid`, [clubId]);
    const club = clubs.at(0);
    if (!club) throw new BadRequestException("Club not found");
    if (club.join_mode !== "open")
      throw new BadRequestException("Club is not open join");
    await this.assertNotBanned(clubId, steamId);
    await this.assertJoinRequirements(clubId, steamId);
    await this.postgres.query(
      `INSERT INTO public.club_members (club_id, steam_id, role)
       VALUES ($1::uuid, $2::bigint, 'member')
       ON CONFLICT DO NOTHING`,
      [clubId, steamId],
    );
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
      this.logger.error(`Club queue match create failed queue=${queueId}: ${err}`);
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
    if (!match?.id) throw new BadRequestException("Failed to create club match");

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
