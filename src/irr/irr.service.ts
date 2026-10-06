import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";

@Injectable()
export class IrrService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly logger: Logger,
  ) {}

  /** Balance in Rials (IRR). UI converts to Tomans. */
  public async getBalance(steamId: string | bigint): Promise<number> {
    const rows = await this.postgres.query<Array<{ irr_balance: string | number }>>(
      `SELECT irr_balance FROM players WHERE steam_id = $1 LIMIT 1`,
      [steamId.toString()],
    );
    return Number(rows.at(0)?.irr_balance ?? 0);
  }

  public async credit(args: {
    steamId: string | bigint;
    amountIrr: number;
    reason: string;
    refType?: string;
    refId?: string;
  }): Promise<number> {
    const amount = Math.floor(Number(args.amountIrr));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException("Credit amount must be positive");
    }
    const steamId = args.steamId.toString();

    if (args.refType && args.refId) {
      const dup = await this.postgres.query<Array<{ id: string }>>(
        `SELECT id FROM irr_ledger
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
          `SELECT 1 FROM irr_ledger
           WHERE steam_id = $1 AND ref_type = $2 AND ref_id = $3 AND delta > 0
           LIMIT 1`,
          [steamId, args.refType, args.refId],
        );
        if (already.rowCount) {
          const bal = await client.query(
            `SELECT irr_balance FROM players WHERE steam_id = $1`,
            [steamId],
          );
          return Number(bal.rows[0]?.irr_balance ?? 0);
        }
      }

      const updated = await client.query(
        `UPDATE players
         SET irr_balance = irr_balance + $2
         WHERE steam_id = $1
         RETURNING irr_balance`,
        [steamId, amount],
      );
      if (!updated.rowCount) {
        throw new BadRequestException(`Player ${steamId} not found`);
      }
      const balanceAfter = Number(updated.rows[0]?.irr_balance ?? 0);
      await client.query(
        `INSERT INTO irr_ledger
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
        `IRR credit amount=${amount} reason=${args.reason} steam=${steamId} bal=${balanceAfter}`,
      );
      return balanceAfter;
    });
  }

  public async listBalances(limit = 50) {
    const n = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
    return this.postgres.query<
      Array<{
        steam_id: string;
        name: string | null;
        avatar_url: string | null;
        irr_balance: string | number;
      }>
    >(
      `SELECT steam_id::text, name, avatar_url, irr_balance
       FROM players
       WHERE irr_balance > 0
       ORDER BY irr_balance DESC, name ASC NULLS LAST
       LIMIT $1`,
      [n],
    );
  }
}
