import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";

export type YpointCostKey =
  | "duel"
  | "wingman"
  | "trios"
  | "draft_create"
  | "draft_join";

@Injectable()
export class YpointService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly logger: Logger,
  ) {}

  public async getBalance(steamId: string | bigint): Promise<number> {
    const rows = await this.postgres.query<Array<{ ypoint_balance: number }>>(
      `SELECT ypoint_balance FROM players WHERE steam_id = $1 LIMIT 1`,
      [steamId.toString()],
    );
    return Number(rows.at(0)?.ypoint_balance ?? 0);
  }

  private async settingNumber(
    name: SystemSettingName,
    fallback: number,
  ): Promise<number> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [name],
    );
    const raw = rows.at(0)?.value;
    if (raw === undefined || raw === null || raw === "") return fallback;
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
  }

  private async settingFlag(
    name: SystemSettingName,
    fallback = false,
  ): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [name],
    );
    const raw = rows.at(0)?.value;
    if (raw === undefined || raw === null || raw === "") return fallback;
    return raw === "true" || raw === "1";
  }

  public async getCosts(): Promise<Record<YpointCostKey, number>> {
    const [duel, wingman, trios, draftCreate, draftJoin, freeDuel, freeWingman, freeTrios] =
      await Promise.all([
        this.settingNumber(SystemSettingName.YpointCostDuel, 8),
        this.settingNumber(SystemSettingName.YpointCostWingman, 0),
        this.settingNumber(SystemSettingName.YpointCostTrios, 12),
        this.settingNumber(SystemSettingName.YpointCostDraftCreate, 15),
        this.settingNumber(SystemSettingName.YpointCostDraftJoin, 10),
        this.settingFlag(SystemSettingName.YpointFreeDuel, false),
        this.settingFlag(SystemSettingName.YpointFreeWingman, false),
        this.settingFlag(SystemSettingName.YpointFreeTrios, false),
      ]);
    return {
      duel: freeDuel ? 0 : Math.max(0, Number(duel) || 0),
      wingman: freeWingman ? 0 : Math.max(0, Number(wingman) || 0),
      trios: freeTrios ? 0 : Math.max(0, Number(trios) || 0),
      draft_create: Math.max(0, Number(draftCreate) || 0),
      draft_join: Math.max(0, Number(draftJoin) || 0),
    };
  }

  public async costForMatchType(type: string): Promise<number> {
    const costs = await this.getCosts();
    if (type === "Duel") return costs.duel;
    if (type === "Wingman") return costs.wingman;
    if (type === "Trios") return costs.trios;
    return 0;
  }

  /** Throws if any player cannot cover `amount`. amount 0 = no-op. */
  public async assertCanAfford(
    steamIds: Array<string | bigint>,
    amount: number,
  ): Promise<void> {
    if (amount <= 0 || steamIds.length === 0) return;
    const ids = [...new Set(steamIds.map((s) => s.toString()))];
    const rows = await this.postgres.query<
      Array<{ steam_id: string; ypoint_balance: number }>
    >(
      `SELECT steam_id::text, ypoint_balance
       FROM players
       WHERE steam_id = ANY($1::bigint[])`,
      [ids],
    );
    const map = new Map(rows.map((r) => [r.steam_id, Number(r.ypoint_balance)]));
    for (const id of ids) {
      const bal = map.get(id) ?? 0;
      if (bal < amount) {
        throw new BadRequestException(
          `Insufficient Ypoints (need ${amount}, have ${bal})`,
        );
      }
    }
  }

  /**
   * Debit each steam id by `amount` once (idempotent via ref_type+ref_id+steam_id).
   * Returns false if amount is 0. Throws if any balance is too low.
   */
  public async debitMany(args: {
    steamIds: Array<string | bigint>;
    amount: number;
    reason: string;
    refType: string;
    refId: string;
  }): Promise<boolean> {
    const { amount, reason, refType, refId } = args;
    if (amount <= 0) return false;
    const ids = [...new Set(args.steamIds.map((s) => s.toString()))];

    await this.postgres.transaction(async (client) => {
      for (const steamId of ids) {
        const already = await client.query(
          `SELECT 1 FROM ypoint_ledger
           WHERE steam_id = $1 AND ref_type = $2 AND ref_id = $3 AND delta < 0
           LIMIT 1`,
          [steamId, refType, refId],
        );
        if (already.rowCount) continue;

        const updated = await client.query(
          `UPDATE players
           SET ypoint_balance = ypoint_balance - $2
           WHERE steam_id = $1 AND ypoint_balance >= $2
           RETURNING ypoint_balance`,
          [steamId, amount],
        );
        if (!updated.rowCount) {
          throw new BadRequestException(
            `Insufficient Ypoints for ${steamId} (need ${amount})`,
          );
        }
        const balanceAfter = Number(updated.rows[0].ypoint_balance);
        await client.query(
          `INSERT INTO ypoint_ledger
             (steam_id, delta, balance_after, reason, ref_type, ref_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [steamId, -amount, balanceAfter, reason, refType, refId],
        );
      }
    });

    this.logger.log(
      `Ypoint debit amount=${amount} reason=${reason} ref=${refType}:${refId} players=${ids.length}`,
    );
    return true;
  }

  public async credit(args: {
    steamId: string | bigint;
    amount: number;
    reason: string;
    refType?: string;
    refId?: string;
  }): Promise<number> {
    const amount = Math.floor(args.amount);
    if (amount <= 0) {
      throw new BadRequestException("Credit amount must be positive");
    }
    const steamId = args.steamId.toString();

    if (args.refType && args.refId) {
      const dup = await this.postgres.query<Array<{ id: string }>>(
        `SELECT id FROM ypoint_ledger
         WHERE steam_id = $1 AND ref_type = $2 AND ref_id = $3 AND delta > 0
         LIMIT 1`,
        [steamId, args.refType, args.refId],
      );
      if (dup.length) {
        return this.getBalance(steamId);
      }
    }

    return this.postgres.transaction(async (client) => {
      if (args.refType && args.refId) {
        const already = await client.query(
          `SELECT 1 FROM ypoint_ledger
           WHERE steam_id = $1 AND ref_type = $2 AND ref_id = $3 AND delta > 0
           LIMIT 1`,
          [steamId, args.refType, args.refId],
        );
        if (already.rowCount) {
          const bal = await client.query(
            `SELECT ypoint_balance FROM players WHERE steam_id = $1`,
            [steamId],
          );
          return Number(bal.rows[0]?.ypoint_balance ?? 0);
        }
      }

      const updated = await client.query(
        `UPDATE players
         SET ypoint_balance = ypoint_balance + $2
         WHERE steam_id = $1
         RETURNING ypoint_balance`,
        [steamId, amount],
      );
      const balanceAfter = Number(updated.rows[0]?.ypoint_balance ?? 0);
      await client.query(
        `INSERT INTO ypoint_ledger
           (steam_id, delta, balance_after, reason, ref_type, ref_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          steamId,
          amount,
          balanceAfter,
          args.reason,
          args.refType || null,
          args.refId || null,
        ],
      );
      this.logger.log(
        `Ypoint credit steam=${steamId} amount=${amount} balance=${balanceAfter}`,
      );
      return balanceAfter;
    });
  }

  public async chargeDraftCreate(steamId: string | bigint, draftGameId: string) {
    const costs = await this.getCosts();
    await this.debitMany({
      steamIds: [steamId],
      amount: costs.draft_create,
      reason: "draft_create",
      refType: "draft_create",
      refId: draftGameId,
    });
  }

  public async chargeDraftJoin(steamId: string | bigint, draftGameId: string) {
    const costs = await this.getCosts();
    await this.debitMany({
      steamIds: [steamId],
      amount: costs.draft_join,
      reason: "draft_join",
      refType: "draft_join",
      refId: `${draftGameId}:${steamId}`,
    });
  }

  /** Admin panel: players with highest Ypoint balances. */
  public async listBalances(limit = 50) {
    const capped = Math.min(200, Math.max(1, Math.floor(limit) || 50));
    return this.postgres.query<
      Array<{
        steam_id: string;
        name: string | null;
        avatar_url: string | null;
        ypoint_balance: number;
      }>
    >(
      `SELECT steam_id::text, name, avatar_url, ypoint_balance
       FROM players
       WHERE ypoint_balance > 0
       ORDER BY ypoint_balance DESC, name ASC NULLS LAST
       LIMIT $1`,
      [capped],
    );
  }

  /** Admin panel: look up a player by SteamID64 or name substring. */
  public async findPlayers(query: string, limit = 20) {
    const q = query.trim();
    if (!q) return [];
    const capped = Math.min(50, Math.max(1, limit));

    if (/^\d{15,20}$/.test(q)) {
      return this.postgres.query<
        Array<{
          steam_id: string;
          name: string | null;
          avatar_url: string | null;
          ypoint_balance: number;
        }>
      >(
        `SELECT steam_id::text, name, avatar_url, ypoint_balance
         FROM players
         WHERE steam_id = $1
         LIMIT 1`,
        [q],
      );
    }

    return this.postgres.query<
      Array<{
        steam_id: string;
        name: string | null;
        avatar_url: string | null;
        ypoint_balance: number;
      }>
    >(
      `SELECT steam_id::text, name, avatar_url, ypoint_balance
       FROM players
       WHERE name ILIKE '%' || $1 || '%'
       ORDER BY name ASC NULLS LAST
       LIMIT $2`,
      [q, capped],
    );
  }

  /**
   * Admin add/remove Ypoints. Positive delta credits, negative debits.
   * Balance cannot go below 0.
   */
  public async adminAdjust(args: {
    targetSteamId: string;
    delta: number;
    adminSteamId: string;
    note?: string;
  }): Promise<{ balance: number; delta: number }> {
    const delta = Math.trunc(Number(args.delta));
    if (!Number.isFinite(delta) || delta === 0) {
      throw new BadRequestException("delta must be a non-zero integer");
    }
    if (!/^\d{15,20}$/.test(args.targetSteamId)) {
      throw new BadRequestException("Invalid Steam ID");
    }

    const exists = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text FROM players WHERE steam_id = $1 LIMIT 1`,
      [args.targetSteamId],
    );
    if (!exists.length) {
      throw new BadRequestException("Player not found");
    }

    const note = (args.note || "").trim().slice(0, 200);
    const reason = note
      ? `admin_adjust:${note}`
      : `admin_adjust:${args.adminSteamId}`;
    const refId = `${args.adminSteamId}:${Date.now()}:${Math.abs(delta)}`;

    if (delta > 0) {
      const balance = await this.credit({
        steamId: args.targetSteamId,
        amount: delta,
        reason,
        refType: "admin_adjust",
        refId,
      });
      return { balance, delta };
    }

    const amount = Math.abs(delta);
    await this.debitMany({
      steamIds: [args.targetSteamId],
      amount,
      reason,
      refType: "admin_adjust",
      refId,
    });
    return { balance: await this.getBalance(args.targetSteamId), delta };
  }
}
