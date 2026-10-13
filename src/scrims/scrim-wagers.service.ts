import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { AppConfig } from "../configs/types/AppConfig";
import { e_player_roles_enum } from "generated/schema";

// Scrims are always Competitive, so the five players the lineup trigger would
// put in first are the ones whose wallets back the team.
const STAKING_PLAYERS = 5;
const DEFAULT_RAKE_PERCENT = 5;
const MAX_RAKE_PERCENT = 50;

export type WagerStake = {
  team_id: string;
  steam_id: string;
  amount: number;
};

export type WagerOutcomeRow = {
  request_exists: boolean;
  status: string | null;
  from_team_id: string | null;
  to_team_id: string | null;
  canceled_late: boolean | null;
  canceled_by_team_id: string | null;
  match_outcome: string | null;
  match_winner_team_id: string | null;
  from_team_checked_in: boolean | null;
  to_team_checked_in: boolean | null;
  match_id: string | null;
  match_status: string | null;
  live_winner_team_id: string | null;
  live_from_no_show: boolean | null;
  live_to_no_show: boolean | null;
};

export type WagerOutcome =
  | { action: "wait" }
  | { action: "refund" }
  | { action: "pay"; winnerTeamId: string };

const DECIDED_STATUSES = ["Finished", "Forfeit", "Surrendered"];

// CancelExpiredMatches flips the match to Canceled first and records who never
// connected afterwards, so a cancel is only judged once that has had time to land.
const CANCEL_GRACE_MS = 2 * 60 * 1000;

@Injectable()
export class ScrimWagersService {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
    private readonly configService: ConfigService,
    private readonly logger: Logger,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  private async setting(name: SystemSettingName): Promise<string | undefined> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM settings WHERE name = $1`,
      [name],
    );
    return rows.at(0)?.value;
  }

  public async isEnabled(): Promise<boolean> {
    return (await this.setting(SystemSettingName.ScrimWagerEnabled)) !== "false";
  }

  public async rakePercent(): Promise<number> {
    const raw = await this.setting(SystemSettingName.ScrimWagerRakePercent);
    if (raw === undefined || raw === null || raw === "") {
      return DEFAULT_RAKE_PERCENT;
    }
    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value)) {
      return DEFAULT_RAKE_PERCENT;
    }
    return Math.min(MAX_RAKE_PERCENT, Math.max(0, value));
  }

  public static normalizeWager(value: unknown): number {
    if (value === undefined || value === null || value === "") {
      return 0;
    }
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount < 0) {
      throw new BadRequestException("the wager must be a whole number of Ypoints");
    }
    return amount;
  }

  /** `total` split as evenly as integers allow; the first players carry the remainder. */
  public static splitEvenly(total: number, count: number): Array<number> {
    if (count <= 0) {
      return [];
    }
    const base = Math.floor(total / count);
    const remainder = total % count;
    return Array.from({ length: count }, (_, index) =>
      index < remainder ? base + 1 : base,
    );
  }

  /**
   * What every staker gets back. Winners share the pot less the rake in
   * proportion to what they put in; losers get nothing. Without a winner (or
   * when the winning side staked nothing) everyone is refunded in full.
   */
  public static payouts(
    stakes: Array<WagerStake>,
    winnerTeamId: string | null,
    rakePercent: number,
  ): Map<string, number> {
    const result = new Map<string, number>();
    const winners = winnerTeamId
      ? stakes.filter((stake) => stake.team_id === winnerTeamId)
      : [];

    if (winners.length === 0) {
      for (const stake of stakes) {
        result.set(stake.steam_id, stake.amount);
      }
      return result;
    }

    const pot = stakes.reduce((sum, stake) => sum + stake.amount, 0);
    const rake = Math.floor((pot * rakePercent) / 100);
    const distributable = pot - rake;
    const winnerTotal = winners.reduce((sum, stake) => sum + stake.amount, 0);

    for (const stake of stakes) {
      result.set(stake.steam_id, 0);
    }

    let paid = 0;
    for (const stake of winners) {
      const share = Math.floor((distributable * stake.amount) / winnerTotal);
      result.set(stake.steam_id, share);
      paid += share;
    }

    const ordered = [...winners].sort(
      (a, b) => b.amount - a.amount || a.steam_id.localeCompare(b.steam_id),
    );
    for (let index = 0; paid < distributable; index++) {
      const stake = ordered[index % ordered.length];
      result.set(stake.steam_id, result.get(stake.steam_id) + 1);
      paid++;
    }

    return result;
  }

  public static resolveOutcome(row: WagerOutcomeRow): WagerOutcome {
    if (!row.request_exists) {
      return { action: "refund" };
    }

    const other = (teamId: string) =>
      teamId === row.from_team_id ? row.to_team_id : row.from_team_id;

    if (row.canceled_late && row.canceled_by_team_id) {
      return { action: "pay", winnerTeamId: other(row.canceled_by_team_id) };
    }

    // Only one side failing to turn up decides it; both or neither is a wash.
    const presentWinner = (
      fromPresent: boolean | null,
      toPresent: boolean | null,
    ): WagerOutcome => {
      if (fromPresent && !toPresent) {
        return { action: "pay", winnerTeamId: row.from_team_id };
      }
      if (toPresent && !fromPresent) {
        return { action: "pay", winnerTeamId: row.to_team_id };
      }
      return { action: "refund" };
    };

    if (row.match_id) {
      if (DECIDED_STATUSES.includes(row.match_status)) {
        return row.live_winner_team_id
          ? { action: "pay", winnerTeamId: row.live_winner_team_id }
          : { action: "refund" };
      }
      if (row.match_status === "Tie") {
        return { action: "refund" };
      }
      if (row.match_status === "Canceled") {
        return presentWinner(!row.live_from_no_show, !row.live_to_no_show);
      }
      return { action: "wait" };
    }

    // Escrow happens before the match exists, so an open request with no
    // match is mid-accept rather than abandoned. An accept that died there
    // leaves the request to expire, and that refunds it.
    if (["Pending", "Countered", "Matched"].includes(row.status)) {
      return { action: "wait" };
    }

    if (DECIDED_STATUSES.includes(row.match_outcome)) {
      return row.match_winner_team_id
        ? { action: "pay", winnerTeamId: row.match_winner_team_id }
        : { action: "refund" };
    }
    if (row.match_outcome === "Canceled") {
      return presentWinner(row.from_team_checked_in, row.to_team_checked_in);
    }
    return { action: "refund" };
  }

  /** The players a team's share of the wager is taken from, in lineup order. */
  public async stakingPlayers(
    teamId: string,
  ): Promise<Array<{ steam_id: string; name: string | null }>> {
    return await this.postgres.query<
      Array<{ steam_id: string; name: string | null }>
    >(
      `SELECT tr.player_steam_id::text AS steam_id, p.name
         FROM team_roster tr
         JOIN teams t ON t.id = tr.team_id
         LEFT JOIN players p ON p.steam_id = tr.player_steam_id
        WHERE tr.team_id = $1
        ORDER BY
            CASE WHEN tr.player_steam_id = t.captain_steam_id THEN 0 ELSE 1 END,
            CASE tr.status
                WHEN 'Starter' THEN 1
                WHEN 'Substitute' THEN 2
                WHEN 'Benched' THEN 3
                ELSE 4
            END,
            tr.player_steam_id
        LIMIT ${STAKING_PLAYERS}`,
      [teamId],
    );
  }

  private async teamStakes(
    teamId: string,
    wager: number,
  ): Promise<Array<WagerStake & { name: string | null }>> {
    const players = await this.stakingPlayers(teamId);
    if (players.length === 0) {
      throw new BadRequestException("a team needs players on its roster to wager");
    }
    const shares = ScrimWagersService.splitEvenly(wager, players.length);
    return players.map((player, index) => ({
      team_id: teamId,
      steam_id: player.steam_id,
      name: player.name,
      amount: shares[index],
    }));
  }

  /** Fails early, with the player's name, when a team's share can't be covered. */
  public async assertTeamCanCover(teamId: string, wager: number): Promise<void> {
    if (wager <= 0) {
      return;
    }
    const stakes = await this.teamStakes(teamId, wager);
    const balances = await this.postgres.query<
      Array<{ steam_id: string; ypoint_balance: number }>
    >(
      `SELECT steam_id::text, ypoint_balance
         FROM players
        WHERE steam_id = ANY($1::bigint[])`,
      [stakes.map((stake) => stake.steam_id)],
    );
    const byId = new Map(
      balances.map((row) => [row.steam_id, Number(row.ypoint_balance)]),
    );
    for (const stake of stakes) {
      if ((byId.get(stake.steam_id) ?? 0) < stake.amount) {
        throw new BadRequestException(
          `${stake.name ?? stake.steam_id} does not have enough Ypoints for the wager (needs ${stake.amount})`,
        );
      }
    }
  }

  /**
   * Takes each team's wager out of its players' wallets, all or nothing.
   * Calling it again for an already escrowed request does nothing.
   */
  public async escrow(request: {
    id: string;
    from_team_id: string;
    to_team_id: string;
    wager_ypoints: number;
  }): Promise<boolean> {
    const wager = Number(request.wager_ypoints) || 0;
    if (wager <= 0) {
      return false;
    }

    if (!(await this.isEnabled())) {
      throw new BadRequestException("scrim wagers are currently disabled");
    }

    const [fromStakes, toStakes] = await Promise.all([
      this.teamStakes(request.from_team_id, wager),
      this.teamStakes(request.to_team_id, wager),
    ]);
    const fromIds = new Set(fromStakes.map((stake) => stake.steam_id));
    if (toStakes.some((stake) => fromIds.has(stake.steam_id))) {
      throw new BadRequestException(
        "a player can't stake on both sides of a scrim wager",
      );
    }

    const rakePercent = await this.rakePercent();
    const stakes = [...fromStakes, ...toStakes];

    const escrowed = await this.postgres.transaction(async (client) => {
      const locked = await client.query(
        `SELECT wager_status FROM team_scrim_requests WHERE id = $1 FOR UPDATE`,
        [request.id],
      );
      if (!locked.rowCount) {
        throw new BadRequestException("scrim request not found");
      }
      if (locked.rows[0].wager_status) {
        return false;
      }

      for (const stake of stakes) {
        const updated = await client.query(
          `UPDATE players
              SET ypoint_balance = ypoint_balance - $2
            WHERE steam_id = $1 AND ypoint_balance >= $2
        RETURNING ypoint_balance`,
          [stake.steam_id, stake.amount],
        );
        if (!updated.rowCount) {
          throw new BadRequestException(
            `${stake.name ?? stake.steam_id} does not have enough Ypoints for the wager (needs ${stake.amount})`,
          );
        }
        await client.query(
          `INSERT INTO ypoint_ledger
             (steam_id, delta, balance_after, reason, ref_type, ref_id)
           VALUES ($1, $2, $3, 'scrim_wager', 'scrim_wager', $4)`,
          [
            stake.steam_id,
            -stake.amount,
            Number(updated.rows[0].ypoint_balance),
            request.id,
          ],
        );
        await client.query(
          `INSERT INTO team_scrim_wager_stakes (request_id, team_id, steam_id, amount)
           VALUES ($1, $2, $3, $4)`,
          [request.id, stake.team_id, stake.steam_id, stake.amount],
        );
      }

      await client.query(
        `UPDATE team_scrim_requests
            SET wager_status = 'Escrowed', wager_rake_percent = $2
          WHERE id = $1`,
        [request.id, rakePercent],
      );
      return true;
    });

    if (escrowed) {
      this.logger.log(
        `[scrim-wager] escrowed ${wager} per team on ${request.id} from ${stakes.length} players`,
      );
      await this.notifyStakers(
        stakes,
        "Scrim Wager Locked",
        (stake) =>
          `${stake.amount} Ypoints were staked from your wallet on a scrim. Win it and your team takes the pot.`,
        request.id,
      );
    }
    return escrowed;
  }

  /** Pays out or refunds every unsettled stake on the request, once. */
  public async settle(
    requestId: string,
    winnerTeamId: string | null,
  ): Promise<void> {
    const settled = await this.postgres.transaction(async (client) => {
      const rows = await client.query(
        `SELECT team_id::text, steam_id::text, amount
           FROM team_scrim_wager_stakes
          WHERE request_id = $1 AND settled_at IS NULL
          ORDER BY steam_id
            FOR UPDATE`,
        [requestId],
      );
      if (!rows.rowCount) {
        return null;
      }
      const stakes: Array<WagerStake> = rows.rows.map((row) => ({
        team_id: row.team_id,
        steam_id: row.steam_id,
        amount: Number(row.amount),
      }));

      const rakeRows = await client.query(
        `SELECT wager_rake_percent FROM team_scrim_requests WHERE id = $1`,
        [requestId],
      );
      const rakePercent = Number(
        rakeRows.rows[0]?.wager_rake_percent ?? DEFAULT_RAKE_PERCENT,
      );

      const payouts = ScrimWagersService.payouts(
        stakes,
        winnerTeamId,
        rakePercent,
      );
      const paidWinner =
        winnerTeamId !== null &&
        stakes.some((stake) => stake.team_id === winnerTeamId)
          ? winnerTeamId
          : null;
      const reason = paidWinner ? "scrim_wager_win" : "scrim_wager_refund";

      for (const stake of stakes) {
        const payout = payouts.get(stake.steam_id) ?? 0;
        if (payout > 0) {
          const updated = await client.query(
            `UPDATE players
                SET ypoint_balance = ypoint_balance + $2
              WHERE steam_id = $1
          RETURNING ypoint_balance`,
            [stake.steam_id, payout],
          );
          if (updated.rowCount) {
            await client.query(
              `INSERT INTO ypoint_ledger
                 (steam_id, delta, balance_after, reason, ref_type, ref_id)
               VALUES ($1, $2, $3, $4, $4, $5)`,
              [
                stake.steam_id,
                payout,
                Number(updated.rows[0].ypoint_balance),
                reason,
                requestId,
              ],
            );
          }
        }
        await client.query(
          `UPDATE team_scrim_wager_stakes
              SET payout = $3, settled_at = now()
            WHERE request_id = $1 AND steam_id = $2`,
          [requestId, stake.steam_id, payout],
        );
      }

      await client.query(
        `UPDATE team_scrim_requests
            SET wager_status = $2,
                wager_winner_team_id = $3,
                wager_settled_at = now()
          WHERE id = $1`,
        [requestId, paidWinner ? "Paid" : "Refunded", paidWinner],
      );

      return { stakes, payouts, paidWinner };
    });

    if (!settled) {
      return;
    }

    const { stakes, payouts, paidWinner } = settled;
    this.logger.log(
      `[scrim-wager] ${requestId} ${paidWinner ? `paid to team ${paidWinner}` : "refunded"}`,
    );

    await this.notifyStakers(
      stakes,
      "Scrim Wager Settled",
      (stake) => {
        const payout = payouts.get(stake.steam_id) ?? 0;
        if (!paidWinner) {
          return `The scrim wager was refunded: ${payout} Ypoints are back in your wallet.`;
        }
        return stake.team_id === paidWinner
          ? `Your team won the scrim wager: ${payout} Ypoints were added to your wallet.`
          : `Your team lost the scrim wager and its ${stake.amount} Ypoints stake.`;
      },
      requestId,
    );
  }

  /** Refunds an escrow whose accept fell through, so the request can be accepted again. */
  public async releaseFailedEscrow(requestId: string): Promise<void> {
    await this.settle(requestId, null);
    await this.postgres.query(
      `DELETE FROM team_scrim_wager_stakes WHERE request_id = $1`,
      [requestId],
    );
    await this.postgres.query(
      `UPDATE team_scrim_requests
          SET wager_status = NULL,
              wager_winner_team_id = NULL,
              wager_settled_at = NULL
        WHERE id = $1`,
      [requestId],
    );
  }

  /** Settles every escrow whose scrim has reached an outcome. */
  public async settleDue(): Promise<number> {
    const rows = await this.postgres.query<
      Array<
        WagerOutcomeRow & {
          request_id: string;
          wager_cancel_seen_at: string | null;
        }
      >
    >(
      `SELECT s.request_id::text AS request_id,
              (r.id IS NOT NULL) AS request_exists,
              r.status,
              r.from_team_id::text AS from_team_id,
              r.to_team_id::text AS to_team_id,
              r.canceled_late,
              r.canceled_by_team_id::text AS canceled_by_team_id,
              r.match_outcome,
              r.match_winner_team_id::text AS match_winner_team_id,
              r.from_team_checked_in,
              r.to_team_checked_in,
              r.wager_cancel_seen_at,
              m.id::text AS match_id,
              m.status AS match_status,
              wl.team_id::text AS live_winner_team_id,
              EXISTS (
                SELECT 1
                  FROM abandoned_matches am
                  JOIN match_lineup_players mlp ON mlp.steam_id = am.steam_id
                  JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
                 WHERE am.match_id = m.id
                   AND ml.id IN (m.lineup_1_id, m.lineup_2_id)
                   AND ml.team_id = r.from_team_id
              ) AS live_from_no_show,
              EXISTS (
                SELECT 1
                  FROM abandoned_matches am
                  JOIN match_lineup_players mlp ON mlp.steam_id = am.steam_id
                  JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
                 WHERE am.match_id = m.id
                   AND ml.id IN (m.lineup_1_id, m.lineup_2_id)
                   AND ml.team_id = r.to_team_id
              ) AS live_to_no_show
         FROM (
           SELECT DISTINCT request_id
             FROM team_scrim_wager_stakes
            WHERE settled_at IS NULL
         ) s
         LEFT JOIN team_scrim_requests r ON r.id = s.request_id
         LEFT JOIN matches m ON m.id = r.match_id
         LEFT JOIN match_lineups wl ON wl.id = m.winning_lineup_id`,
    );

    let settledCount = 0;
    for (const row of rows) {
      const outcome = ScrimWagersService.resolveOutcome(row);
      if (outcome.action === "wait") {
        continue;
      }
      if (
        row.match_id &&
        row.match_status === "Canceled" &&
        !row.canceled_late
      ) {
        if (!row.wager_cancel_seen_at) {
          await this.postgres.query(
            `UPDATE team_scrim_requests
                SET wager_cancel_seen_at = now()
              WHERE id = $1 AND wager_cancel_seen_at IS NULL`,
            [row.request_id],
          );
          continue;
        }
        if (
          Date.now() - new Date(row.wager_cancel_seen_at).getTime() <
          CANCEL_GRACE_MS
        ) {
          continue;
        }
      }
      try {
        await this.settle(
          row.request_id,
          outcome.action === "pay" ? outcome.winnerTeamId : null,
        );
        settledCount++;
      } catch (error) {
        this.logger.error(
          `[scrim-wager] failed to settle ${row.request_id}`,
          error,
        );
      }
    }
    return settledCount;
  }

  private async notifyStakers(
    stakes: Array<WagerStake>,
    title: string,
    message: (stake: WagerStake) => string,
    requestId: string,
  ): Promise<void> {
    const link = `<a href="${this.appConfig.webDomain}/scrims">Scrims</a>`;
    for (const stake of stakes) {
      try {
        await this.notifications.notifyPlayers(
          "ScrimWager",
          {
            title,
            message: `${message(stake)} ${link}`,
            role: "user" as e_player_roles_enum,
            entity_id: requestId,
            steamIds: [stake.steam_id],
          },
        );
      } catch (error) {
        this.logger.warn(
          `[scrim-wager] could not notify ${stake.steam_id} about ${requestId}`,
          error,
        );
      }
    }
  }
}
