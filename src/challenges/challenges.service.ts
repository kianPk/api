import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { YpointService } from "../ypoint/ypoint.service";
import {
  ChallengeDef,
  ChallengeMetric,
  ChallengeTier,
  getChallenge,
  pickDailyChallenges,
} from "./challenge-catalog";

type SubRow = {
  tier: ChallengeTier;
  expires_at: string | null;
};

type AssignmentRow = {
  id: string;
  challenge_key: string;
  tier: string;
  target: number;
  progress: number;
  reward_ypoints: number;
  completed_at: string | null;
  rewarded_at: string | null;
};

@Injectable()
export class ChallengesService implements OnModuleInit {
  constructor(
    private readonly postgres: PostgresService,
    private readonly ypoint: YpointService,
    private readonly logger: Logger,
  ) {}

  public onModuleInit() {
    void this.ensureSchema().catch((err) =>
      this.logger.warn(`Challenges schema ensure failed: ${err}`),
    );
  }

  /** Idempotent DDL + seed so Challenges work even if migrate was skipped. */
  public async ensureSchema(): Promise<void> {
    await this.postgres.query(`
      ALTER TABLE public.store_products
        ADD COLUMN IF NOT EXISTS subscription_tier text
    `);
    await this.postgres.query(`
      CREATE TABLE IF NOT EXISTS public.player_subscriptions (
        steam_id bigint PRIMARY KEY REFERENCES public.players (steam_id)
          ON UPDATE CASCADE ON DELETE CASCADE,
        tier text NOT NULL CHECK (tier IN ('premium', 'premium_plus')),
        expires_at timestamptz,
        order_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.postgres.query(`
      CREATE TABLE IF NOT EXISTS public.challenge_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        steam_id bigint NOT NULL REFERENCES public.players (steam_id)
          ON UPDATE CASCADE ON DELETE CASCADE,
        day_date date NOT NULL,
        challenge_key text NOT NULL,
        tier text NOT NULL CHECK (tier IN ('premium', 'premium_plus')),
        target integer NOT NULL CHECK (target > 0),
        progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
        reward_ypoints integer NOT NULL CHECK (reward_ypoints >= 0),
        completed_at timestamptz,
        rewarded_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT challenge_assignments_unique
          UNIQUE (steam_id, day_date, challenge_key)
      )
    `);
    await this.postgres.query(`
      INSERT INTO public.store_products (
        title, slug, description, price_irr, active, sort_order,
        subscription_tier, vip_duration
      ) VALUES
        (
          'Premium',
          'premium-30d',
          'Unlock daily Challenges for 30 days. Two Premium challenges every day with Ypoint rewards.',
          1490000, true, 10, 'premium', '30d'
        ),
        (
          'Premium Plus',
          'premium-plus-30d',
          'Unlock Premium Plus Challenges for 30 days. Harder daily goals and bigger Ypoint rewards.',
          2990000, true, 11, 'premium_plus', '30d'
        )
      ON CONFLICT (slug) DO UPDATE SET
        subscription_tier = EXCLUDED.subscription_tier,
        active = true,
        updated_at = now()
    `);
    this.logger.log("Challenges schema ready");
  }

  /** Tehran calendar day YYYY-MM-DD. */
  public todayTehran(): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tehran",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  public async getActiveSubscription(
    steamId: string,
  ): Promise<SubRow | null> {
    const rows = await this.postgres.query<SubRow[]>(
      `SELECT tier, expires_at::text
       FROM public.player_subscriptions
       WHERE steam_id = $1::bigint
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 1`,
      [steamId],
    );
    return rows.at(0) ?? null;
  }

  public async grantSubscription(args: {
    steamId: string;
    tier: ChallengeTier;
    duration: string;
    orderId: string;
  }): Promise<void> {
    const expiresAt = durationToExpiry(args.duration);
    const tierRank = (t: ChallengeTier) => (t === "premium_plus" ? 2 : 1);

    await this.postgres.query(
      `INSERT INTO public.player_subscriptions (steam_id, tier, expires_at, order_id)
       VALUES ($1::bigint, $2, $3::timestamptz, $4::uuid)
       ON CONFLICT (steam_id) DO UPDATE SET
         tier = CASE
           WHEN player_subscriptions.expires_at IS NOT NULL
             AND player_subscriptions.expires_at <= now()
           THEN EXCLUDED.tier
           WHEN $5::int >= CASE player_subscriptions.tier
             WHEN 'premium_plus' THEN 2 ELSE 1 END
           THEN EXCLUDED.tier
           ELSE player_subscriptions.tier
         END,
         expires_at = CASE
           WHEN EXCLUDED.expires_at IS NULL THEN NULL
           WHEN player_subscriptions.expires_at IS NOT NULL
             AND player_subscriptions.expires_at > now()
             AND EXCLUDED.expires_at IS NOT NULL
           THEN player_subscriptions.expires_at
                + (EXCLUDED.expires_at - now())
           ELSE EXCLUDED.expires_at
         END,
         order_id = EXCLUDED.order_id,
         updated_at = now()`,
      [
        args.steamId,
        args.tier,
        expiresAt,
        args.orderId,
        tierRank(args.tier),
      ],
    );
    this.logger.log(
      `Subscription granted steam=${args.steamId} tier=${args.tier} order=${args.orderId}`,
    );
  }

  public async getMyChallenges(steamId: string) {
    if (!steamId) throw new UnauthorizedException("Login required");
    await this.ensureSchema();

    const sub = await this.getActiveSubscription(steamId);
    if (!sub) {
      return {
        unlocked: false,
        subscription: null as SubRow | null,
        day: this.todayTehran(),
        challenges: [] as unknown[],
        products: await this.subscriptionProducts(),
      };
    }

    const day = this.todayTehran();
    const tier = sub.tier as ChallengeTier;
    const picked = pickDailyChallenges(steamId, day, tier, 2);

    for (const def of picked) {
      await this.postgres.query(
        `INSERT INTO public.challenge_assignments
           (steam_id, day_date, challenge_key, tier, target, reward_ypoints)
         VALUES ($1::bigint, $2::date, $3, $4, $5, $6)
         ON CONFLICT (steam_id, day_date, challenge_key) DO NOTHING`,
        [steamId, day, def.key, def.tier, def.target, def.reward],
      );
    }

    const rows = await this.postgres.query<AssignmentRow[]>(
      `SELECT id::text, challenge_key, tier, target, progress,
              reward_ypoints, completed_at::text, rewarded_at::text
       FROM public.challenge_assignments
       WHERE steam_id = $1::bigint AND day_date = $2::date
       ORDER BY created_at ASC`,
      [steamId, day],
    );

    const refreshed = [];
    for (const row of rows) {
      const def = getChallenge(row.challenge_key);
      if (!def) continue;
      const progress = await this.computeProgress(steamId, day, def);
      const completed = progress >= def.target;
      await this.postgres.query(
        `UPDATE public.challenge_assignments
         SET progress = $2,
             completed_at = CASE
               WHEN $3 AND completed_at IS NULL THEN now()
               ELSE completed_at
             END,
             updated_at = now()
         WHERE id = $1::uuid`,
        [row.id, Math.min(progress, def.target), completed],
      );

      let rewardedAt = row.rewarded_at;
      if (completed && !row.rewarded_at) {
        rewardedAt = await this.creditReward(steamId, row);
      }

      refreshed.push({
        id: row.id,
        key: def.key,
        tier: def.tier,
        target: def.target,
        progress: Math.min(progress, def.target),
        reward_ypoints: def.reward,
        completed,
        rewarded: !!rewardedAt,
        match_type: def.matchType ?? null,
        kind: def.kind,
        metric: def.metric ?? null,
      });
    }

    return {
      unlocked: true,
      subscription: {
        tier: sub.tier,
        expires_at: sub.expires_at,
      },
      day,
      challenges: refreshed,
      products: await this.subscriptionProducts(),
    };
  }

  private async creditReward(
    steamId: string,
    row: AssignmentRow,
  ): Promise<string | null> {
    try {
      await this.ypoint.credit({
        steamId,
        amount: row.reward_ypoints,
        reason: "challenge_reward",
        refType: "challenge_assignment",
        refId: row.id,
      });
      await this.postgres.query(
        `UPDATE public.challenge_assignments
         SET rewarded_at = now(), updated_at = now()
         WHERE id = $1::uuid AND rewarded_at IS NULL`,
        [row.id],
      );
      return new Date().toISOString();
    } catch (err) {
      this.logger.warn(
        `Challenge reward failed id=${row.id}: ${err}`,
      );
      return null;
    }
  }

  private async subscriptionProducts() {
    return this.postgres.query<
      Array<{
        id: string;
        title: string;
        slug: string;
        description: string;
        price_irr: number;
        subscription_tier: string;
        vip_duration: string | null;
      }>
    >(
      `SELECT id::text, title, slug, description, price_irr,
              subscription_tier, vip_duration
       FROM public.store_products
       WHERE active = true
         AND subscription_tier IS NOT NULL
       ORDER BY sort_order ASC, created_at DESC`,
    );
  }

  private async computeProgress(
    steamId: string,
    day: string,
    def: ChallengeDef,
  ): Promise<number> {
    const dayStart = day;
    const matches = await this.postgres.query<
      Array<{
        match_id: string;
        type: string | null;
        won: number;
        kills: number;
        deaths: number;
        assists: number;
        damage: number;
        hs_kills: number;
        enemies_flashed: number;
        flash_assists: number;
        knife_kills: number;
        zeus_kills: number;
        three_kill_rounds: number;
        four_kill_rounds: number;
        five_kill_rounds: number;
        trade_kill_successes: number;
        he_damage: number;
        molotov_damage: number;
        rounds_played: number;
        kast_rounds: number;
        kast_total_rounds: number;
      }>
    >(
      `SELECT
         m.id::text AS match_id,
         mo.type::text AS type,
         CASE WHEN EXISTS (
           SELECT 1 FROM match_maps mm
           WHERE mm.match_id = m.id
             AND mm.status = 'Finished'
             AND mm.winning_lineup_id = ml.id
         ) THEN 1 ELSE 0 END AS won,
         COALESCE(SUM(pms.kills), 0)::int AS kills,
         COALESCE(SUM(pms.deaths), 0)::int AS deaths,
         COALESCE(SUM(pms.assists), 0)::int AS assists,
         COALESCE(SUM(pms.damage), 0)::int AS damage,
         COALESCE(SUM(pms.hs_kills), 0)::int AS hs_kills,
         COALESCE(SUM(pms.enemies_flashed), 0)::int AS enemies_flashed,
         COALESCE(SUM(pms.flash_assists), 0)::int AS flash_assists,
         COALESCE(SUM(pms.knife_kills), 0)::int AS knife_kills,
         COALESCE(SUM(pms.zeus_kills), 0)::int AS zeus_kills,
         COALESCE(SUM(pms.three_kill_rounds), 0)::int AS three_kill_rounds,
         COALESCE(SUM(pms.four_kill_rounds), 0)::int AS four_kill_rounds,
         COALESCE(SUM(pms.five_kill_rounds), 0)::int AS five_kill_rounds,
         COALESCE(SUM(pms.trade_kill_successes), 0)::int AS trade_kill_successes,
         COALESCE(SUM(pms.he_damage), 0)::int AS he_damage,
         COALESCE(SUM(pms.molotov_damage), 0)::int AS molotov_damage,
         COALESCE(SUM(pms.rounds_played), 0)::int AS rounds_played,
         COALESCE(SUM(pms.kast_rounds), 0)::int AS kast_rounds,
         COALESCE(SUM(pms.kast_total_rounds), 0)::int AS kast_total_rounds
       FROM match_lineup_players mlp
       JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
       JOIN matches m ON m.id = ml.match_id
       LEFT JOIN match_options mo ON mo.id = m.match_options_id
       LEFT JOIN player_match_map_stats pms
         ON pms.match_id = m.id AND pms.steam_id = mlp.steam_id
       WHERE mlp.steam_id = $1::bigint
         AND m.status = 'Finished'
         AND (COALESCE(m.ended_at, m.created_at) AT TIME ZONE 'Asia/Tehran')::date = $2::date
       GROUP BY m.id, mo.type, ml.id`,
      [steamId, dayStart],
    );

    const typeOk = (t: string | null) =>
      !def.matchType || t === def.matchType;

    if (def.kind === "win_matches") {
      return matches.filter((m) => m.won === 1 && typeOk(m.type)).length;
    }
    if (def.kind === "play_matches") {
      return matches.filter((m) => typeOk(m.type)).length;
    }

    const metric = def.metric!;
    const valueOf = (m: (typeof matches)[0]): number =>
      this.metricValue(m, metric);

    if (def.kind === "metric_day") {
      return matches
        .filter((m) => typeOk(m.type))
        .reduce((sum, m) => sum + valueOf(m), 0);
    }

    // metric_single — best single match today
    let best = 0;
    for (const m of matches) {
      if (!typeOk(m.type)) continue;
      best = Math.max(best, valueOf(m));
    }
    return best;
  }

  private metricValue(
    m: {
      kills: number;
      deaths: number;
      assists: number;
      damage: number;
      hs_kills: number;
      enemies_flashed: number;
      flash_assists: number;
      knife_kills: number;
      zeus_kills: number;
      three_kill_rounds: number;
      four_kill_rounds: number;
      five_kill_rounds: number;
      trade_kill_successes: number;
      he_damage: number;
      molotov_damage: number;
      rounds_played: number;
      kast_rounds: number;
      kast_total_rounds: number;
    },
    metric: ChallengeMetric,
  ): number {
    switch (metric) {
      case "kills":
        return m.kills;
      case "damage":
        return m.damage;
      case "hs_kills":
        return m.hs_kills;
      case "assists":
        return m.assists;
      case "enemies_flashed":
        return m.enemies_flashed;
      case "flash_assists":
        return m.flash_assists;
      case "knife_kills":
        return m.knife_kills;
      case "zeus_kills":
        return m.zeus_kills;
      case "three_kill_rounds":
        return m.three_kill_rounds;
      case "four_kill_rounds":
        return m.four_kill_rounds;
      case "five_kill_rounds":
        return m.five_kill_rounds;
      case "trade_kill_successes":
        return m.trade_kill_successes;
      case "he_damage":
        return m.he_damage;
      case "molotov_damage":
        return m.molotov_damage;
      case "kd_ratio": {
        const deaths = Math.max(1, m.deaths);
        return Math.floor((m.kills / deaths) * 100);
      }
      case "adr": {
        if (m.rounds_played <= 0) return 0;
        return Math.floor(m.damage / m.rounds_played);
      }
      case "kast_pct": {
        if (m.kast_total_rounds <= 0) return 0;
        return Math.floor((m.kast_rounds / m.kast_total_rounds) * 100);
      }
      default:
        return 0;
    }
  }

  public assertUnlocked(unlocked: boolean): void {
    if (!unlocked) {
      throw new ForbiddenException(
        "Premium or Premium Plus subscription required",
      );
    }
  }
}

function durationToExpiry(duration: string): string | null {
  const s = duration.trim().toLowerCase();
  if (
    s === "perm" ||
    s === "permanent" ||
    s === "0" ||
    s === "lifetime" ||
    s === "forever"
  ) {
    return null;
  }
  const m = s.match(
    /^(\d+)\s*(m|min|mins|h|hr|hrs|d|day|days|w|week|weeks|mo|month|months)$/,
  );
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const ms = /^(m|min|mins)$/.test(unit)
    ? n * 60_000
    : /^(h|hr|hrs)$/.test(unit)
      ? n * 3_600_000
      : /^(d|day|days)$/.test(unit)
        ? n * 86_400_000
        : /^(w|week|weeks)$/.test(unit)
          ? n * 7 * 86_400_000
          : n * 30 * 86_400_000;
  return new Date(Date.now() + ms).toISOString();
}
