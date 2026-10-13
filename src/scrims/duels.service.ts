import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import { MatchAssistantService } from "../matches/match-assistant/match-assistant.service";
import { AppConfig } from "../configs/types/AppConfig";
import { ScrimWagersService, WagerOutcome } from "./scrim-wagers.service";
import { e_notification_types_enum, e_player_roles_enum } from "generated/schema";

const ASAP_TTL_MS = 30 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OPEN_OUTGOING = 5;
const CANCEL_GRACE_MS = 2 * 60 * 1000;
const LISTING_TTL_HOURS = 12;
// A duel can still be called off while nobody has fired a shot.
const CANCELABLE_MATCH_STATUSES = [
  "PickingPlayers",
  "Scheduled",
  "WaitingForCheckIn",
  "Veto",
  "WaitingForServer",
];
const FINISHED_MATCH_STATUSES = [
  "Finished",
  "Tie",
  "Canceled",
  "Forfeit",
  "Surrendered",
];

export type DuelRequest = {
  id: string;
  from_steam_id: string;
  to_steam_id: string;
  status: string;
  best_of: number;
  map_id: string | null;
  proposed_scheduled_at: string | null;
  match_id: string | null;
  expires_at: string;
  wager_ypoints: number;
};

type DuelOutcomeRow = DuelRequest & {
  canceled_late: boolean;
  canceled_by_steam_id: string | null;
  match_outcome: string | null;
  match_winner_steam_id: string | null;
  from_no_show: boolean | null;
  to_no_show: boolean | null;
  wager_cancel_seen_at: string | null;
  match_status: string | null;
  live_winner_steam_id: string | null;
  live_from_no_show: boolean;
  live_to_no_show: boolean;
};

@Injectable()
export class DuelsService {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
    private readonly matchAssistant: MatchAssistantService,
    private readonly wagers: ScrimWagersService,
    private readonly configService: ConfigService,
    private readonly logger: Logger,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  /** Player ids stand in for team ids, so the scrim wager rules apply as-is. */
  public static resolveOutcome(row: DuelOutcomeRow): WagerOutcome {
    return ScrimWagersService.resolveOutcome({
      request_exists: true,
      status: row.status,
      from_team_id: row.from_steam_id,
      to_team_id: row.to_steam_id,
      canceled_late: row.canceled_late,
      canceled_by_team_id: row.canceled_by_steam_id,
      match_outcome: row.match_outcome,
      match_winner_team_id: row.match_winner_steam_id,
      from_team_checked_in: row.from_no_show === null ? null : !row.from_no_show,
      to_team_checked_in: row.to_no_show === null ? null : !row.to_no_show,
      match_id: row.match_id,
      match_status: row.match_status,
      live_winner_team_id: row.live_winner_steam_id,
      live_from_no_show: row.live_from_no_show,
      live_to_no_show: row.live_to_no_show,
    });
  }

  /** Winner takes the pot less the rake; without a winner both get their stake back. */
  public static payouts(
    request: { from_steam_id: string; to_steam_id: string; wager_ypoints: number },
    winnerSteamId: string | null,
    rakePercent: number,
  ): Map<string, number> {
    return ScrimWagersService.payouts(
      [request.from_steam_id, request.to_steam_id].map((steam_id) => ({
        team_id: steam_id,
        steam_id,
        amount: request.wager_ypoints,
      })),
      winnerSteamId,
      rakePercent,
    );
  }

  private async isFinderEnabled(): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM settings WHERE name = 'public.scrim_finder_enabled'`,
    );
    return rows.at(0)?.value !== "false";
  }

  private async playerName(steamId: string): Promise<string> {
    const rows = await this.postgres.query<Array<{ name: string | null }>>(
      `SELECT name FROM players WHERE steam_id = $1`,
      [steamId],
    );
    return NotificationsService.escapeHtml(rows.at(0)?.name || "A player");
  }

  private async duelMapPoolId(): Promise<string | null> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT mp.id::text AS id
         FROM map_pools mp
        WHERE mp.type = 'Duel' AND mp.enabled = true
          AND EXISTS (SELECT 1 FROM v_pool_maps pm WHERE pm.map_pool_id = mp.id)
        ORDER BY mp.seed DESC
        LIMIT 1`,
    );
    return rows.at(0)?.id ?? null;
  }

  private async load(requestId: string): Promise<DuelRequest> {
    const rows = await this.postgres.query<Array<DuelRequest>>(
      `SELECT id::text, from_steam_id::text, to_steam_id::text, status, best_of,
              map_id::text, proposed_scheduled_at, match_id::text, expires_at,
              wager_ypoints
         FROM player_duel_requests
        WHERE id = $1`,
      [requestId],
    );
    const request = rows.at(0);
    if (!request) {
      throw new BadRequestException("1v1 request not found");
    }
    return request;
  }

  private async hasActiveDuel(steamIds: Array<string>): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1
           FROM player_duel_requests r
           JOIN matches m ON m.id = r.match_id
          WHERE r.status = 'Matched'
            AND (r.from_steam_id = ANY($1::bigint[]) OR r.to_steam_id = ANY($1::bigint[]))
            AND m.status <> ALL($2::text[])
       ) AS exists`,
      [steamIds, FINISHED_MATCH_STATUSES],
    );
    return rows.at(0)?.exists === true;
  }

  public async sendDuelRequest(params: {
    fromSteamId: string;
    toSteamId: string;
    bestOf?: number | null;
    mapId?: string | null;
    proposedScheduledAt?: string | null;
    wagerYpoints?: number | null;
  }): Promise<string> {
    const { fromSteamId, toSteamId } = params;
    const bestOf = params.bestOf ?? 1;
    const mapId = params.mapId || null;
    const wager = ScrimWagersService.normalizeWager(params.wagerYpoints);

    if (!(await this.isFinderEnabled())) {
      throw new BadRequestException("the scrim finder is disabled");
    }
    if (String(fromSteamId) === String(toSteamId)) {
      throw new BadRequestException("you can't challenge yourself");
    }
    if (![1, 3, 5].includes(bestOf)) {
      throw new BadRequestException("a 1v1 is best of 1, 3 or 5");
    }
    if (mapId && bestOf !== 1) {
      throw new BadRequestException("a fixed map only works for a best of 1");
    }

    let proposedAt: Date | null = null;
    if (params.proposedScheduledAt) {
      proposedAt = new Date(params.proposedScheduledAt);
      if (Number.isNaN(proposedAt.getTime())) {
        throw new BadRequestException("invalid time");
      }
      if (proposedAt.getTime() <= Date.now() + 60_000) {
        proposedAt = null;
      } else if (proposedAt.getTime() > Date.now() + MAX_SCHEDULE_AHEAD_MS) {
        throw new BadRequestException("a 1v1 can be set at most a week ahead");
      }
    }

    const [opponent] = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text FROM players WHERE steam_id = $1`,
      [toSteamId],
    );
    if (!opponent) {
      throw new BadRequestException("player not found");
    }

    if (mapId) {
      const poolId = await this.duelMapPoolId();
      const [inPool] = await this.postgres.query<Array<{ ok: boolean }>>(
        `SELECT true AS ok FROM v_pool_maps WHERE map_pool_id = $1 AND id = $2`,
        [poolId, mapId],
      );
      if (!inPool) {
        throw new BadRequestException("that map isn't in the 1v1 map pool");
      }
    }

    if (wager > 0) {
      if (!(await this.wagers.isEnabled())) {
        throw new BadRequestException("wagers are currently disabled");
      }
      const [balance] = await this.postgres.query<
        Array<{ ypoint_balance: number }>
      >(`SELECT ypoint_balance FROM players WHERE steam_id = $1`, [fromSteamId]);
      if (Number(balance?.ypoint_balance ?? 0) < wager) {
        throw new BadRequestException(
          `you don't have enough Ypoints for this wager (needs ${wager})`,
        );
      }
    }

    const [{ open }] = await this.postgres.query<Array<{ open: number }>>(
      `SELECT count(*)::int AS open
         FROM player_duel_requests
        WHERE from_steam_id = $1 AND status = 'Pending'`,
      [fromSteamId],
    );
    if (open >= MAX_OPEN_OUTGOING) {
      throw new BadRequestException(
        `you already have ${MAX_OPEN_OUTGOING} open challenges: cancel one first`,
      );
    }

    const expiresAt = proposedAt ?? new Date(Date.now() + ASAP_TTL_MS);

    let id: string;
    try {
      [{ id }] = await this.postgres.query<Array<{ id: string }>>(
        `INSERT INTO player_duel_requests
            (from_steam_id, to_steam_id, best_of, map_id, proposed_scheduled_at,
             expires_at, wager_ypoints)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id::text`,
        [
          fromSteamId,
          toSteamId,
          bestOf,
          mapId,
          proposedAt?.toISOString() ?? null,
          expiresAt.toISOString(),
          wager,
        ],
      );
    } catch (error) {
      if (String(error).includes("uq_duel_req_open")) {
        throw new BadRequestException(
          "there is already an open 1v1 challenge between you two",
        );
      }
      throw error;
    }

    const name = await this.playerName(fromSteamId);
    const what = wager > 0 ? `a 1v1 for ${wager} Ypoints` : "a 1v1";
    const when = proposedAt ? "" : " right now";
    await this.notify([toSteamId], {
      type: "ScrimRequestReceived",
      title: "1v1 Challenge",
      message: `${this.playerLink(fromSteamId, name)} challenged you to ${what}${when}.`,
      requestId: id,
      actions: [
        this.action("Accept", "respondToDuelRequest", { request_id: id, accept: true }),
        this.action("Decline", "respondToDuelRequest", { request_id: id, accept: false }),
      ],
    });

    return id;
  }

  public async respondToDuelRequest(params: {
    requestId: string;
    steamId: string;
    accept: boolean;
  }): Promise<string | null> {
    const request = await this.load(params.requestId);

    if (request.status !== "Pending") {
      throw new BadRequestException("this challenge can no longer be answered");
    }
    if (String(request.to_steam_id) !== String(params.steamId)) {
      throw new BadRequestException("this challenge isn't addressed to you");
    }
    if (new Date(request.expires_at).getTime() <= Date.now()) {
      throw new BadRequestException("this challenge has expired");
    }

    if (params.accept) {
      const matchId = await this.acceptDuel(request);
      await this.clearRequestNotifications(request.id);
      return matchId;
    }

    await this.clearRequestNotifications(request.id);
    await this.postgres.query(
      `UPDATE player_duel_requests
          SET status = 'Declined', responded_at = now()
        WHERE id = $1 AND status = 'Pending'`,
      [request.id],
    );
    const name = await this.playerName(request.to_steam_id);
    await this.notify([request.from_steam_id], {
      type: "ScrimRequestDeclined",
      title: "1v1 Declined",
      message: `${this.playerLink(request.to_steam_id, name)} declined your 1v1 challenge.`,
      requestId: request.id,
    });
    return null;
  }

  private async acceptDuel(request: DuelRequest): Promise<string> {
    const players = [request.from_steam_id, request.to_steam_id];
    if (await this.hasActiveDuel(players)) {
      throw new BadRequestException("one of you is already in an unfinished 1v1");
    }

    const escrowed = await this.escrow(request);

    let matchId: string;
    try {
      const scheduledAt =
        request.proposed_scheduled_at &&
        new Date(request.proposed_scheduled_at).getTime() > Date.now()
          ? request.proposed_scheduled_at
          : new Date().toISOString();

      const options = await this.matchOptions(request);
      // No organizer: neither player gets to cancel the match or pick its
      // winner around the challenge (and its stake).
      const match = await this.matchAssistant.createScheduledMatch(
        null as unknown as string,
        {
          options,
          scheduled_at: new Date(scheduledAt).toISOString(),
          lineup_1: { steam_ids: [request.from_steam_id] },
          lineup_2: { steam_ids: [request.to_steam_id] },
        },
      );
      matchId = match.id;

      await this.postgres.query(
        `UPDATE player_duel_requests
            SET status = 'Matched', match_id = $2, responded_at = now()
          WHERE id = $1`,
        [request.id, matchId],
      );
    } catch (error) {
      if (escrowed) {
        await this.refundEscrow(request.id);
      }
      throw error;
    }

    const link = `${this.appConfig.webDomain}/matches/${matchId}`;
    const [fromName, toName] = await Promise.all([
      this.playerName(request.from_steam_id),
      this.playerName(request.to_steam_id),
    ]);
    for (const [steamId, opponentId, opponentName] of [
      [request.from_steam_id, request.to_steam_id, toName],
      [request.to_steam_id, request.from_steam_id, fromName],
    ]) {
      await this.notify([steamId], {
        type: "ScrimMatchScheduled",
        title: "1v1 On",
        message: `Your 1v1 against ${this.playerLink(opponentId, opponentName)} is set. <a href="${link}">Open the match</a>.`,
        requestId: request.id,
        actions: [
          this.action("Cancel 1v1", "cancelDuelRequest", { request_id: request.id }),
        ],
      });
    }

    this.logger.log(`[duel] ${request.id} scheduled as match ${matchId}`);
    return matchId;
  }

  private async matchOptions(
    request: DuelRequest,
  ): Promise<Record<string, unknown>> {
    let mapPoolId: string | null;
    if (request.map_id) {
      const [pool] = await this.postgres.query<Array<{ id: string }>>(
        `INSERT INTO map_pools (type) VALUES ('Custom') RETURNING id::text`,
      );
      await this.postgres.query(
        `INSERT INTO _map_pool (map_pool_id, map_id) VALUES ($1, $2)`,
        [pool.id, request.map_id],
      );
      mapPoolId = pool.id;
    } else {
      mapPoolId = await this.duelMapPoolId();
      if (!mapPoolId) {
        throw new BadRequestException(
          "there is no 1v1 map pool: ask an administrator to set one up",
        );
      }
    }

    return {
      type: "Duel",
      mr: 8,
      best_of: request.best_of,
      overtime: true,
      knife_round: false,
      coaches: false,
      map_veto: !request.map_id,
      map_pool_id: mapPoolId,
    };
  }

  public async cancelDuelRequest(params: {
    requestId: string;
    steamId: string;
  }): Promise<void> {
    const request = await this.load(params.requestId);
    const steamId = String(params.steamId);

    if (request.status === "Pending") {
      if (String(request.from_steam_id) !== steamId) {
        throw new BadRequestException("only the challenger can withdraw a challenge");
      }
      await this.clearRequestNotifications(request.id);
      await this.postgres.query(
        `UPDATE player_duel_requests
            SET status = 'Cancelled', responded_at = now()
          WHERE id = $1 AND status = 'Pending'`,
        [request.id],
      );
      return;
    }

    if (request.status !== "Matched") {
      throw new BadRequestException("this challenge can no longer be cancelled");
    }
    if (![request.from_steam_id, request.to_steam_id].map(String).includes(steamId)) {
      throw new BadRequestException("you are not in this 1v1");
    }

    if (request.match_id) {
      const [match] = await this.postgres.query<Array<{ status: string }>>(
        `SELECT status FROM matches WHERE id = $1`,
        [request.match_id],
      );
      if (match && !CANCELABLE_MATCH_STATUSES.includes(match.status)) {
        throw new BadRequestException("the match has already started");
      }
    }

    // The bail is recorded before the match flips, so the canceled match is
    // never mistaken for a no-show.
    await this.postgres.query(
      `UPDATE player_duel_requests
          SET status = 'Cancelled', canceled_late = true,
              canceled_by_steam_id = $2, responded_at = now()
        WHERE id = $1`,
      [request.id, steamId],
    );
    if (request.match_id) {
      await this.postgres.query(
        `UPDATE matches SET status = 'Canceled' WHERE id = $1`,
        [request.match_id],
      );
    }
    await this.clearRequestNotifications(request.id, ["ScrimMatchScheduled"]);

    const opponentId =
      steamId === String(request.from_steam_id)
        ? request.to_steam_id
        : request.from_steam_id;
    const name = await this.playerName(steamId);
    await this.notify([opponentId], {
      type: "ScrimMatchCanceled",
      title: "1v1 Canceled",
      message:
        request.wager_ypoints > 0
          ? `${this.playerLink(steamId, name)} called off your 1v1 and forfeits the wager to you.`
          : `${this.playerLink(steamId, name)} called off your 1v1.`,
      requestId: request.id,
    });
  }

  public async expireStale(): Promise<number> {
    await this.postgres.query(
      `DELETE FROM player_duel_listings
        WHERE created_at < now() - interval '${LISTING_TTL_HOURS} hours'`,
    );

    const expired = await this.postgres.query<
      Array<{ id: string; from_steam_id: string }>
    >(
      `UPDATE player_duel_requests
          SET status = 'Expired', responded_at = now()
        WHERE status = 'Pending' AND expires_at < now()
    RETURNING id::text, from_steam_id::text`,
    );
    for (const request of expired) {
      await this.clearRequestNotifications(request.id);
      await this.notify([request.from_steam_id], {
        type: "ScrimRequestExpired",
        title: "1v1 Expired",
        message: "Your 1v1 challenge expired without an answer.",
        requestId: request.id,
      });
    }
    return expired.length;
  }

  /** Takes the stake from both players at once, or from neither. */
  private async escrow(request: DuelRequest): Promise<boolean> {
    const wager = Number(request.wager_ypoints) || 0;
    if (wager <= 0) {
      return false;
    }
    if (!(await this.wagers.isEnabled())) {
      throw new BadRequestException("wagers are currently disabled");
    }
    const rakePercent = await this.wagers.rakePercent();

    const escrowed = await this.postgres.transaction(async (client) => {
      const locked = await client.query(
        `SELECT wager_status FROM player_duel_requests WHERE id = $1 FOR UPDATE`,
        [request.id],
      );
      if (!locked.rowCount || locked.rows[0].wager_status) {
        return false;
      }
      for (const steamId of [request.from_steam_id, request.to_steam_id]) {
        const updated = await client.query(
          `UPDATE players
              SET ypoint_balance = ypoint_balance - $2
            WHERE steam_id = $1 AND ypoint_balance >= $2
        RETURNING ypoint_balance, name`,
          [steamId, wager],
        );
        if (!updated.rowCount) {
          const [player] = await this.postgres.query<Array<{ name: string }>>(
            `SELECT name FROM players WHERE steam_id = $1`,
            [steamId],
          );
          throw new BadRequestException(
            `${player?.name ?? steamId} does not have enough Ypoints for the wager (needs ${wager})`,
          );
        }
        await client.query(
          `INSERT INTO ypoint_ledger
             (steam_id, delta, balance_after, reason, ref_type, ref_id)
           VALUES ($1, $2, $3, 'duel_wager', 'duel_wager', $4)`,
          [steamId, -wager, Number(updated.rows[0].ypoint_balance), request.id],
        );
      }
      await client.query(
        `UPDATE player_duel_requests
            SET wager_status = 'Escrowed', wager_rake_percent = $2
          WHERE id = $1`,
        [request.id, rakePercent],
      );
      return true;
    });

    if (escrowed) {
      this.logger.log(`[duel-wager] escrowed ${wager} each on ${request.id}`);
    }
    return escrowed;
  }

  /** Pays out or refunds an escrowed stake, once. */
  public async settle(
    requestId: string,
    winnerSteamId: string | null,
  ): Promise<void> {
    const settled = await this.postgres.transaction(async (client) => {
      const rows = await client.query(
        `SELECT from_steam_id::text, to_steam_id::text, wager_ypoints,
                wager_rake_percent
           FROM player_duel_requests
          WHERE id = $1 AND wager_status = 'Escrowed'
            FOR UPDATE`,
        [requestId],
      );
      if (!rows.rowCount) {
        return null;
      }
      const request = {
        from_steam_id: rows.rows[0].from_steam_id as string,
        to_steam_id: rows.rows[0].to_steam_id as string,
        wager_ypoints: Number(rows.rows[0].wager_ypoints),
      };
      const winner =
        winnerSteamId &&
        [request.from_steam_id, request.to_steam_id].includes(String(winnerSteamId))
          ? String(winnerSteamId)
          : null;
      const payouts = DuelsService.payouts(
        request,
        winner,
        Number(rows.rows[0].wager_rake_percent ?? 0),
      );
      const reason = winner ? "duel_wager_win" : "duel_wager_refund";

      for (const [steamId, payout] of payouts) {
        if (payout <= 0) {
          continue;
        }
        const updated = await client.query(
          `UPDATE players
              SET ypoint_balance = ypoint_balance + $2
            WHERE steam_id = $1
        RETURNING ypoint_balance`,
          [steamId, payout],
        );
        if (updated.rowCount) {
          await client.query(
            `INSERT INTO ypoint_ledger
               (steam_id, delta, balance_after, reason, ref_type, ref_id)
             VALUES ($1, $2, $3, $4, 'duel_wager', $5)`,
            [steamId, payout, Number(updated.rows[0].ypoint_balance), reason, requestId],
          );
        }
      }

      await client.query(
        `UPDATE player_duel_requests
            SET wager_status = $2, wager_winner_steam_id = $3,
                wager_settled_at = now()
          WHERE id = $1`,
        [requestId, winner ? "Paid" : "Refunded", winner],
      );
      return { request, payouts, winner };
    });

    if (!settled) {
      return;
    }

    const { request, payouts, winner } = settled;
    this.logger.log(
      `[duel-wager] ${requestId} ${winner ? `paid to ${winner}` : "refunded"}`,
    );
    for (const steamId of [request.from_steam_id, request.to_steam_id]) {
      const payout = payouts.get(steamId) ?? 0;
      const message = !winner
        ? `The 1v1 wager was refunded: ${payout} Ypoints are back in your wallet.`
        : steamId === winner
          ? `You won the 1v1 wager: ${payout} Ypoints were added to your wallet.`
          : `You lost the 1v1 wager and its ${request.wager_ypoints} Ypoints stake.`;
      await this.notify([steamId], {
        type: "ScrimWager",
        title: "1v1 Wager Settled",
        message,
        requestId,
      });
    }
  }

  /** Gives both stakes back after an accept that fell through, so it can be retried. */
  private async refundEscrow(requestId: string): Promise<void> {
    await this.settle(requestId, null);
    await this.postgres.query(
      `UPDATE player_duel_requests
          SET wager_status = NULL, wager_winner_steam_id = NULL,
              wager_settled_at = NULL
        WHERE id = $1`,
      [requestId],
    );
  }

  public async settleDue(): Promise<number> {
    const rows = await this.postgres.query<Array<DuelOutcomeRow & { wager_cancel_seen_at: string | null }>>(
      `SELECT r.id::text, r.from_steam_id::text, r.to_steam_id::text, r.status,
              r.best_of, r.map_id::text, r.proposed_scheduled_at,
              r.match_id::text, r.expires_at, r.wager_ypoints,
              r.canceled_late, r.canceled_by_steam_id::text,
              r.match_outcome, r.match_winner_steam_id::text,
              r.from_no_show, r.to_no_show, r.wager_cancel_seen_at,
              m.status AS match_status,
              (SELECT mlp.steam_id::text
                 FROM match_lineup_players mlp
                WHERE mlp.match_lineup_id = m.winning_lineup_id
                ORDER BY mlp.steam_id
                LIMIT 1) AS live_winner_steam_id,
              EXISTS (SELECT 1 FROM abandoned_matches am
                       WHERE am.match_id = m.id AND am.steam_id = r.from_steam_id
                     ) AS live_from_no_show,
              EXISTS (SELECT 1 FROM abandoned_matches am
                       WHERE am.match_id = m.id AND am.steam_id = r.to_steam_id
                     ) AS live_to_no_show
         FROM player_duel_requests r
         LEFT JOIN matches m ON m.id = r.match_id
        WHERE r.wager_status = 'Escrowed'`,
    );

    let settledCount = 0;
    for (const row of rows) {
      const outcome = DuelsService.resolveOutcome({
        ...row,
        match_id: row.match_status ? row.match_id : null,
      });
      if (outcome.action === "wait") {
        continue;
      }
      if (row.match_status === "Canceled" && !row.canceled_late) {
        if (!row.wager_cancel_seen_at) {
          await this.postgres.query(
            `UPDATE player_duel_requests
                SET wager_cancel_seen_at = now()
              WHERE id = $1 AND wager_cancel_seen_at IS NULL`,
            [row.id],
          );
          continue;
        }
        if (Date.now() - new Date(row.wager_cancel_seen_at).getTime() < CANCEL_GRACE_MS) {
          continue;
        }
      }
      try {
        await this.settle(
          row.id,
          outcome.action === "pay" ? outcome.winnerTeamId : null,
        );
        settledCount++;
      } catch (error) {
        this.logger.error(`[duel-wager] failed to settle ${row.id}`, error);
      }
    }
    return settledCount;
  }

  private playerLink(steamId: string, safeName: string): string {
    return `<a href="${this.appConfig.webDomain}/players/${steamId}">${safeName}</a>`;
  }

  private action(
    label: string,
    action: string,
    variables: Record<string, unknown>,
  ) {
    return {
      label,
      graphql: {
        type: "mutation",
        action,
        selection: { success: true },
        variables,
      },
    };
  }

  private async clearRequestNotifications(
    requestId: string,
    types: Array<string> = ["ScrimRequestReceived"],
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE notifications
          SET is_read = true, deleted_at = now()
        WHERE entity_id = $1
          AND type = ANY($2::text[])
          AND deleted_at IS NULL`,
      [requestId, types],
    );
  }

  private async notify(
    steamIds: Array<string>,
    params: {
      type: string;
      title: string;
      message: string;
      requestId: string;
      actions?: Array<ReturnType<DuelsService["action"]>>;
    },
  ): Promise<void> {
    try {
      await this.notifications.notifyPlayers(
        params.type as e_notification_types_enum,
        {
          title: params.title,
          message: params.message,
          role: "user" as e_player_roles_enum,
          entity_id: params.requestId,
          steamIds,
        },
        params.actions,
      );
    } catch (error) {
      this.logger.warn(`[duel] could not notify about ${params.requestId}`, error);
    }
  }
}
