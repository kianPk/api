import { Injectable, Logger } from "@nestjs/common";
import { Redis } from "ioredis";
import { PostgresService } from "../postgres/postgres.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import {
  SERVER_SECTION_MODES,
  type ServerSectionMode,
} from "../game-plugins/server-section-modes";

const LOCK_KEY = "servers-section:reconcile";
const MAX_SERVERS_PER_MODE = 50;
const DEFAULT_RESERVE_SLOTS = 2;

// The Servers section owns its servers: an operator only says how many each
// mode should have, and this keeps the fleet at that number. A server is
// created on the node with the most free match slots and removed from the
// highest number down, so "Duels #1" is always the one that stays.
@Injectable()
export class ServersSectionService {
  private redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    redisManager: RedisManagerService,
  ) {
    this.redis = redisManager.getConnection();
  }

  public static countSetting(mode: ServerSectionMode["key"]) {
    return `servers_section_${mode}`;
  }

  public static readonly RESERVE_SETTING = "servers_section_reserve_slots";

  // "Duels #3" is server 3. Anything else sorts last, so it is the first to go
  // when the count comes down and its number is free to be reused.
  public static numberOf(label: string | null): number {
    const match = /#(\d+)\s*$/.exec(label || "");
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  }

  public static labelFor(mode: ServerSectionMode, number: number) {
    return `${mode.label} #${number}`;
  }

  public async reconcile(): Promise<void> {
    const locked = await this.redis.set(LOCK_KEY, "1", "EX", 55, "NX");
    if (locked !== "OK") {
      return;
    }

    try {
      const settings = await this.postgres.query<
        Array<{ name: string; value: string }>
      >(
        `SELECT name, value FROM settings WHERE name LIKE 'servers\\_section\\_%'`,
      );
      const values = new Map(settings.map((row) => [row.name, row.value]));
      const number = (name: string, fallback: number, max: number) => {
        const parsed = parseInt(values.get(name) ?? "", 10);
        return Number.isFinite(parsed)
          ? Math.min(Math.max(parsed, 0), max)
          : fallback;
      };

      const reserve = number(
        ServersSectionService.RESERVE_SETTING,
        DEFAULT_RESERVE_SLOTS,
        64,
      );

      for (const mode of Object.values(SERVER_SECTION_MODES)) {
        const desired = number(
          ServersSectionService.countSetting(mode.key),
          0,
          MAX_SERVERS_PER_MODE,
        );
        try {
          await this.reconcileMode(mode, desired, reserve);
        } catch (error) {
          this.logger.warn(
            `servers section: unable to reconcile ${mode.key}`,
            error?.message ?? error,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `servers section: reconcile failed`,
        error?.message ?? error,
      );
    } finally {
      await this.redis.del(LOCK_KEY);
    }
  }

  private async reconcileMode(
    mode: ServerSectionMode,
    desired: number,
    reserve: number,
  ) {
    const servers = (
      await this.postgres.query<Array<{ id: string; label: string | null }>>(
        `SELECT id, label FROM servers WHERE section_mode = $1`,
        [mode.key],
      )
    ).map((server) => ({
      ...server,
      number: ServersSectionService.numberOf(server.label),
    }));

    if (servers.length > desired) {
      const extra = [...servers]
        .sort((a, b) => b.number - a.number)
        .slice(0, servers.length - desired);

      for (const server of extra) {
        this.logger.log(`servers section: removing ${server.label}`);
        await this.postgres.query(`DELETE FROM servers WHERE id = $1`, [
          server.id,
        ]);
      }
      return;
    }

    const taken = new Set(servers.map((server) => server.number));
    let missing = desired - servers.length;

    for (let number = 1; missing > 0; number++) {
      if (taken.has(number)) {
        continue;
      }

      const nodeId = await this.pickNode(reserve);
      if (!nodeId) {
        this.logger.warn(
          `servers section: no node has a free slot for ${mode.label} #${number} (keeping ${reserve} free for matches)`,
        );
        return;
      }

      const label = ServersSectionService.labelFor(mode, number);
      this.logger.log(`servers section: creating ${label} on ${nodeId}`);

      // tbiud_servers takes the node's lowest free slot, its host and region,
      // and encrypts the rcon password; the servers event then deploys it.
      await this.postgres.query(
        `INSERT INTO servers (
            label, section_mode, is_dedicated, enabled, game,
            game_server_node_id, host, port, tv_port, region,
            rcon_password, type, max_players
         ) VALUES (
            $1, $2, true, true, 'cs2',
            $3, '127.0.0.1', 27015, 27020, '',
            gen_random_uuid()::text::bytea, $4, $5
         )`,
        [label, mode.key, nodeId, mode.type, mode.maxPlayers],
      );

      missing--;
    }
  }

  // Free means an on-demand slot nothing has claimed: those are what matches
  // boot on, so a node only takes a section server while it keeps `reserve`
  // of them for matches.
  private async pickNode(reserve: number): Promise<string | null> {
    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT n.id
         FROM game_server_nodes n
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS free
             FROM servers s
            WHERE s.game_server_node_id = n.id
              AND s.is_dedicated = false
              AND s.reserved_by_match_id IS NULL
              AND s.enabled = true
         ) slots
        WHERE n.enabled = true
          AND n.status = 'Online'
          AND slots.free > $1
        ORDER BY slots.free DESC, n.id
        LIMIT 1`,
      [reserve],
    );

    return row?.id ?? null;
  }
}
