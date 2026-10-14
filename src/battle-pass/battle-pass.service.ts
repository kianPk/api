import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { YpointService } from "../ypoint/ypoint.service";
import { ChallengesService } from "../challenges/challenges.service";
import {
  addDays,
  BADGES,
  BadgeKey,
  DAILY_MISSION_COUNT,
  DAILY_MISSIONS,
  DEFAULT_PREMIUM_PRICE_YPOINTS,
  levelForXp,
  MAX_LEVEL,
  matchXp,
  MissionDef,
  missionProgress,
  pickMissions,
  Reward,
  rewardFor,
  SEASON_LENGTH_DAYS,
  SeasonMatch,
  SUBSCRIBER_CHALLENGE_XP,
  Track,
  WEEKLY_MISSION_COUNT,
  WEEKLY_MISSIONS,
  weekStart,
  XP_PER_LEVEL,
} from "./battle-pass-catalog";

export type Season = {
  id: string;
  number: number;
  starts_at: string;
  ends_at: string;
  premium_price_ypoints: number;
};

type MissionView = {
  key: string;
  xp: number;
  target: number;
  progress: number;
  completed: boolean;
  match_type: string | null;
};

type SeasonState = {
  xp: number;
  level: number;
  premium: boolean;
  breakdown: {
    matches: number;
    daily: number;
    weekly: number;
    subscriber: number;
  };
  today: string;
  daily: MissionView[];
  week_start: string;
  weekly: MissionView[];
};

@Injectable()
export class BattlePassService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly ypoint: YpointService,
    private readonly challenges: ChallengesService,
    private readonly logger: Logger,
  ) {}

  public async currentSeason(): Promise<Season | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [current] = await this.postgres.query<Season[]>(
        `SELECT id::text, number, starts_at::text, ends_at::text, premium_price_ypoints
           FROM public.battle_pass_seasons
          WHERE starts_at <= now() AND ends_at > now()
          ORDER BY number DESC
          LIMIT 1`,
      );
      if (current) {
        return current;
      }

      const [last] = await this.postgres.query<
        Array<Season & { upcoming: boolean }>
      >(
        `SELECT id::text, number, starts_at::text, ends_at::text,
                premium_price_ypoints, starts_at > now() AS upcoming
           FROM public.battle_pass_seasons
          ORDER BY number DESC
          LIMIT 1`,
      );
      if (last?.upcoming) {
        return null;
      }

      // Seasons stay aligned to the previous one's end, skipping any that
      // would already be over, so a quiet stretch never stacks up dead seasons.
      await this.postgres.query(
        `INSERT INTO public.battle_pass_seasons
           (number, starts_at, ends_at, premium_price_ypoints)
         SELECT $1::int, s.start_at, s.start_at + make_interval(days => $2::int), $3::int
           FROM (
             SELECT CASE
               WHEN $4::timestamptz IS NULL THEN
                 date_trunc('day', now() AT TIME ZONE 'Asia/Tehran') AT TIME ZONE 'Asia/Tehran'
               ELSE
                 $4::timestamptz + make_interval(
                   days => $2::int * floor(
                     extract(epoch FROM now() - $4::timestamptz) / ($2::int * 86400)
                   )::int
                 )
             END AS start_at
           ) s
         ON CONFLICT (number) DO NOTHING`,
        [
          (last?.number ?? 0) + 1,
          SEASON_LENGTH_DAYS,
          last?.premium_price_ypoints ?? DEFAULT_PREMIUM_PRICE_YPOINTS,
          last?.ends_at ?? null,
        ],
      );
    }
    return null;
  }

  public async getMe(steamId: string) {
    const season = await this.currentSeason();
    if (!season) {
      return { season: null as Season | null };
    }

    let subscriber: Awaited<
      ReturnType<ChallengesService["getMyChallenges"]>
    > | null = null;
    try {
      subscriber = await this.challenges.getMyChallenges(steamId);
    } catch (error) {
      this.logger.warn(`battle pass: subscriber challenges failed: ${error}`);
    }

    const state = await this.refreshProgress(steamId, season);
    const claims = await this.claimedSet(steamId, season.id);
    const subscriberTier = subscriber?.subscription?.tier;

    return {
      season: {
        number: season.number,
        starts_at: season.starts_at,
        ends_at: season.ends_at,
        premium_price_ypoints: season.premium_price_ypoints,
      },
      xp: state.xp,
      level: state.level,
      xp_per_level: XP_PER_LEVEL,
      max_level: MAX_LEVEL,
      premium: state.premium,
      balance: await this.ypoint.getBalance(steamId),
      breakdown: state.breakdown,
      levels: Array.from({ length: MAX_LEVEL }, (_, index) => {
        const level = index + 1;
        return {
          level,
          free: rewardFor(level, "free"),
          premium: rewardFor(level, "premium"),
          free_claimed: claims.has(`${level}:free`),
          premium_claimed: claims.has(`${level}:premium`),
        };
      }),
      daily: {
        day: state.today,
        resets_at: this.tehranMidnightIso(addDays(state.today, 1)),
        missions: state.daily,
      },
      weekly: {
        week_start: state.week_start,
        resets_at: this.tehranMidnightIso(addDays(state.week_start, 7)),
        missions: state.weekly,
      },
      subscriber: subscriber
        ? {
            unlocked: subscriber.unlocked,
            subscription: subscriber.subscription,
            xp_per_challenge: subscriberTier
              ? (SUBSCRIBER_CHALLENGE_XP[subscriberTier] ?? 0)
              : SUBSCRIBER_CHALLENGE_XP.premium,
            challenges: subscriber.challenges,
            products: subscriber.products,
          }
        : null,
    };
  }

  public async claim(steamId: string, level: number, track: Track) {
    const season = await this.requireSeason();
    const state = await this.refreshProgress(steamId, season);
    const reward = await this.claimOne(steamId, season, state, level, track);
    return { success: true, reward };
  }

  public async claimAll(steamId: string) {
    const season = await this.requireSeason();
    const state = await this.refreshProgress(steamId, season);
    const claims = await this.claimedSet(steamId, season.id);

    const rewards: Reward[] = [];
    for (let level = 1; level <= state.level; level++) {
      for (const track of ["free", "premium"] as Track[]) {
        if (track === "premium" && !state.premium) {
          continue;
        }
        if (!rewardFor(level, track) || claims.has(`${level}:${track}`)) {
          continue;
        }
        try {
          rewards.push(
            await this.claimOne(steamId, season, state, level, track),
          );
        } catch (error) {
          this.logger.warn(
            `battle pass: claim ${level}/${track} for ${steamId} failed: ${error}`,
          );
        }
      }
    }
    return { success: true, claimed: rewards.length, rewards };
  }

  public async buyPremium(steamId: string) {
    const season = await this.requireSeason();
    const [progress] = await this.postgres.query<Array<{ premium: boolean }>>(
      `SELECT premium FROM public.battle_pass_progress
        WHERE season_id = $1::uuid AND steam_id = $2::bigint`,
      [season.id, steamId],
    );
    if (progress?.premium) {
      return { success: true };
    }

    await this.ypoint.debitMany({
      steamIds: [steamId],
      amount: season.premium_price_ypoints,
      reason: "battle_pass_premium",
      refType: "battle_pass_premium",
      refId: season.id,
    });

    await this.postgres.query(
      `INSERT INTO public.battle_pass_progress
         (season_id, steam_id, premium, premium_purchased_at)
       VALUES ($1::uuid, $2::bigint, true, now())
       ON CONFLICT (season_id, steam_id) DO UPDATE SET
         premium = true,
         premium_purchased_at = COALESCE(battle_pass_progress.premium_purchased_at, now()),
         updated_at = now()`,
      [season.id, steamId],
    );

    await this.grantBadge(steamId, season, "premium");

    this.logger.log(
      `battle pass: ${steamId} bought Premium for season ${season.number}`,
    );
    return { success: true };
  }

  private async requireSeason(): Promise<Season> {
    const season = await this.currentSeason();
    if (!season) {
      throw new BadRequestException("No Battle Pass season is running");
    }
    return season;
  }

  private async claimOne(
    steamId: string,
    season: Season,
    state: SeasonState,
    level: number,
    track: Track,
  ): Promise<Reward> {
    const reward = rewardFor(level, track);
    if (!reward) {
      throw new BadRequestException("There is no reward on this level");
    }
    if (level > state.level) {
      throw new BadRequestException("You have not reached this level yet");
    }
    if (track === "premium" && !state.premium) {
      throw new ForbiddenException("Unlock the Premium track first");
    }

    const inserted = await this.postgres.query<Array<{ level: number }>>(
      `INSERT INTO public.battle_pass_claims (season_id, steam_id, level, track)
       VALUES ($1::uuid, $2::bigint, $3::int, $4)
       ON CONFLICT DO NOTHING
       RETURNING level`,
      [season.id, steamId, level, track],
    );
    if (!inserted.length) {
      throw new BadRequestException("Reward already claimed");
    }

    try {
      await this.grant(steamId, season, level, track, reward);
    } catch (error) {
      await this.postgres.query(
        `DELETE FROM public.battle_pass_claims
          WHERE season_id = $1::uuid AND steam_id = $2::bigint
            AND level = $3::int AND track = $4`,
        [season.id, steamId, level, track],
      );
      throw error;
    }
    return reward;
  }

  private async grant(
    steamId: string,
    season: Season,
    level: number,
    track: Track,
    reward: Reward,
  ): Promise<void> {
    switch (reward.type) {
      case "ypoints":
        await this.ypoint.credit({
          steamId,
          amount: reward.amount,
          reason: "battle_pass_reward",
          refType: "battle_pass_claim",
          refId: `${season.id}:${level}:${track}`,
        });
        return;
      case "subscription":
        await this.challenges.grantSubscription({
          steamId,
          tier: reward.tier,
          duration: `${reward.days}d`,
          orderId: null,
        });
        return;
      case "badge":
        await this.grantBadge(steamId, season, reward.badge);
        return;
    }
  }

  private async grantBadge(
    steamId: string,
    season: Season,
    badge: BadgeKey,
  ): Promise<void> {
    const def = BADGES[badge];
    const fill = (text: string) =>
      text.replace(/\{season\}/g, String(season.number));

    const [award] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.awards
         (name, description, tier, silhouette, system_key, allow_multiple)
       VALUES ($1, $2, 'special', $3, $4, false)
       ON CONFLICT (system_key) DO UPDATE SET updated_at = now()
       RETURNING id::text`,
      [
        fill(def.name),
        fill(def.description),
        def.silhouette,
        `battle_pass_s${season.number}_${badge}`,
      ],
    );

    const existing = await this.postgres.query<unknown[]>(
      `SELECT 1 FROM public.award_recipients
        WHERE award_id = $1::uuid AND player_steam_id = $2::bigint
        LIMIT 1`,
      [award.id, steamId],
    );
    if (existing.length) {
      return;
    }

    await this.postgres.query(
      `INSERT INTO public.award_recipients
         (award_id, player_steam_id, source, note)
       VALUES ($1::uuid, $2::bigint, 'manual', $3)`,
      [award.id, steamId, `Battle Pass season ${season.number}`],
    );
  }

  private async claimedSet(
    steamId: string,
    seasonId: string,
  ): Promise<Set<string>> {
    const rows = await this.postgres.query<
      Array<{ level: number; track: string }>
    >(
      `SELECT level, track FROM public.battle_pass_claims
        WHERE season_id = $1::uuid AND steam_id = $2::bigint`,
      [seasonId, steamId],
    );
    return new Set(rows.map((row) => `${row.level}:${row.track}`));
  }

  private async refreshProgress(
    steamId: string,
    season: Season,
  ): Promise<SeasonState> {
    const state = await this.computeState(steamId, season);
    const [row] = await this.postgres.query<Array<{ premium: boolean }>>(
      `INSERT INTO public.battle_pass_progress (season_id, steam_id, xp)
       VALUES ($1::uuid, $2::bigint, $3::int)
       ON CONFLICT (season_id, steam_id) DO UPDATE SET
         xp = EXCLUDED.xp,
         updated_at = now()
       RETURNING premium`,
      [season.id, steamId, state.xp],
    );
    state.premium = !!row?.premium;
    return state;
  }

  private async computeState(
    steamId: string,
    season: Season,
  ): Promise<SeasonState> {
    const matches = await this.seasonMatches(steamId, season);
    const firstDay = this.tehranDay(new Date(season.starts_at));
    const lastSeasonDay = this.tehranDay(
      new Date(new Date(season.ends_at).getTime() - 1),
    );
    const today = this.challenges.todayTehran();
    const lastDay = today < lastSeasonDay ? today : lastSeasonDay;

    const byDay = new Map<string, SeasonMatch[]>();
    for (const match of matches) {
      if (!byDay.has(match.day)) {
        byDay.set(match.day, []);
      }
      byDay.get(match.day).push(match);
    }

    const evaluate = (
      missions: MissionDef[],
      pool: SeasonMatch[],
    ): MissionView[] =>
      missions.map((mission) => {
        const progress = missionProgress(mission, pool);
        return {
          key: mission.key,
          xp: mission.xp,
          target: mission.target,
          progress: Math.min(progress, mission.target),
          completed: progress >= mission.target,
          match_type: mission.matchType ?? null,
        };
      });

    let dailyXp = 0;
    let todayMissions: MissionView[] = [];
    for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
      const missions = evaluate(
        pickMissions(
          DAILY_MISSIONS,
          `${steamId}|${day}|daily`,
          DAILY_MISSION_COUNT,
        ),
        byDay.get(day) ?? [],
      );
      dailyXp += missions
        .filter((mission) => mission.completed)
        .reduce((sum, mission) => sum + mission.xp, 0);
      if (day === today) {
        todayMissions = missions;
      }
    }

    let weeklyXp = 0;
    let thisWeek: MissionView[] = [];
    const currentWeek = weekStart(today);
    for (
      let week = weekStart(firstDay);
      week <= lastDay;
      week = addDays(week, 7)
    ) {
      const weekEnd = addDays(week, 7);
      const missions = evaluate(
        pickMissions(
          WEEKLY_MISSIONS,
          `${steamId}|${week}|weekly`,
          WEEKLY_MISSION_COUNT,
        ),
        matches.filter((match) => match.day >= week && match.day < weekEnd),
      );
      weeklyXp += missions
        .filter((mission) => mission.completed)
        .reduce((sum, mission) => sum + mission.xp, 0);
      if (week === currentWeek) {
        thisWeek = missions;
      }
    }

    const subscriberRows = await this.postgres.query<
      Array<{ tier: string; completed: number }>
    >(
      `SELECT tier, COUNT(*)::int AS completed
         FROM public.challenge_assignments
        WHERE steam_id = $1::bigint
          AND completed_at IS NOT NULL
          AND day_date BETWEEN $2::date AND $3::date
        GROUP BY tier`,
      [steamId, firstDay, lastDay],
    );
    const subscriberXp = subscriberRows.reduce(
      (sum, row) =>
        sum + (SUBSCRIBER_CHALLENGE_XP[row.tier] ?? 0) * Number(row.completed),
      0,
    );

    const fromMatches = matchXp(matches);
    const xp = fromMatches + dailyXp + weeklyXp + subscriberXp;

    return {
      xp,
      level: levelForXp(xp),
      premium: false,
      breakdown: {
        matches: fromMatches,
        daily: dailyXp,
        weekly: weeklyXp,
        subscriber: subscriberXp,
      },
      today,
      daily: todayMissions,
      week_start: currentWeek,
      weekly: thisWeek,
    };
  }

  private async seasonMatches(
    steamId: string,
    season: Season,
  ): Promise<SeasonMatch[]> {
    const rows = await this.postgres.query<Array<Record<string, unknown>>>(
      `SELECT
         m.id::text AS match_id,
         mo.type::text AS type,
         to_char(
           (COALESCE(m.ended_at, m.created_at) AT TIME ZONE 'Asia/Tehran')::date,
           'YYYY-MM-DD'
         ) AS day,
         (m.winning_lineup_id IS NOT NULL AND m.winning_lineup_id = ml.id) AS won,
         COALESCE(SUM(pms.rounds_played), 0)::int AS rounds_played,
         COALESCE(SUM(pms.kills), 0)::int AS kills,
         COALESCE(SUM(pms.hs_kills), 0)::int AS hs_kills,
         COALESCE(SUM(pms.damage), 0)::int AS damage,
         COALESCE(SUM(pms.assists), 0)::int AS assists,
         COALESCE(SUM(pms.enemies_flashed), 0)::int AS enemies_flashed,
         COALESCE(SUM(pms.he_damage), 0)::int AS he_damage,
         COALESCE(SUM(pms.three_kill_rounds), 0)::int AS three_kill_rounds,
         COALESCE(SUM(pms.trade_kill_successes), 0)::int AS trade_kill_successes
       FROM match_lineup_players mlp
       JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
       JOIN matches m ON m.id = ml.match_id
       LEFT JOIN match_options mo ON mo.id = m.match_options_id
       LEFT JOIN player_match_map_stats pms
         ON pms.match_id = m.id AND pms.steam_id = mlp.steam_id
       WHERE mlp.steam_id = $1::bigint
         AND m.status = 'Finished'
         AND COALESCE(m.ended_at, m.created_at) >= $2::timestamptz
         AND COALESCE(m.ended_at, m.created_at) < $3::timestamptz
       GROUP BY m.id, mo.type, ml.id
       ORDER BY COALESCE(m.ended_at, m.created_at) ASC`,
      [steamId, season.starts_at, season.ends_at],
    );

    return rows.map((row) => ({
      match_id: String(row.match_id),
      type: (row.type as string) ?? null,
      day: String(row.day),
      won: row.won === true,
      rounds_played: Number(row.rounds_played),
      kills: Number(row.kills),
      hs_kills: Number(row.hs_kills),
      damage: Number(row.damage),
      assists: Number(row.assists),
      enemies_flashed: Number(row.enemies_flashed),
      he_damage: Number(row.he_damage),
      three_kill_rounds: Number(row.three_kill_rounds),
      trade_kill_successes: Number(row.trade_kill_successes),
    }));
  }

  private tehranDay(date: Date): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tehran",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }

  // Iran has had no DST since 2022, so Tehran midnight is a fixed +03:30.
  private tehranMidnightIso(day: string): string {
    return new Date(`${day}T00:00:00+03:30`).toISOString();
  }
}
