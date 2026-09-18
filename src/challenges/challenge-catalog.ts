export type ChallengeTier = "premium" | "premium_plus";

export type ChallengeKind =
  | "win_matches"
  | "play_matches"
  | "metric_single"
  | "metric_day";

export type ChallengeMetric =
  | "kills"
  | "damage"
  | "hs_kills"
  | "assists"
  | "enemies_flashed"
  | "flash_assists"
  | "knife_kills"
  | "zeus_kills"
  | "three_kill_rounds"
  | "four_kill_rounds"
  | "five_kill_rounds"
  | "trade_kill_successes"
  | "he_damage"
  | "molotov_damage"
  | "kd_ratio"
  | "adr"
  | "kast_pct";

export type ChallengeDef = {
  key: string;
  tier: ChallengeTier;
  /** i18n key suffix under pages.challenges.catalog.<key> */
  reward: number;
  target: number;
  kind: ChallengeKind;
  matchType?: "Competitive" | "Wingman" | "Duel" | "Trios";
  metric?: ChallengeMetric;
};

/** 20 Premium + 20 Premium Plus daily-challenge definitions. */
export const CHALLENGE_CATALOG: ChallengeDef[] = [
  // —— Premium (20) ——
  { key: "p_win_comp_1", tier: "premium", reward: 20, target: 1, kind: "win_matches", matchType: "Competitive" },
  { key: "p_win_wing_1", tier: "premium", reward: 18, target: 1, kind: "win_matches", matchType: "Wingman" },
  { key: "p_win_duel_1", tier: "premium", reward: 18, target: 1, kind: "win_matches", matchType: "Duel" },
  { key: "p_win_trios_1", tier: "premium", reward: 20, target: 1, kind: "win_matches", matchType: "Trios" },
  { key: "p_win_any_2", tier: "premium", reward: 28, target: 2, kind: "win_matches" },
  { key: "p_play_2", tier: "premium", reward: 12, target: 2, kind: "play_matches" },
  { key: "p_play_3", tier: "premium", reward: 18, target: 3, kind: "play_matches" },
  { key: "p_kills_15", tier: "premium", reward: 22, target: 15, kind: "metric_single", metric: "kills" },
  { key: "p_kills_25", tier: "premium", reward: 30, target: 25, kind: "metric_single", metric: "kills" },
  { key: "p_dmg_1500", tier: "premium", reward: 22, target: 1500, kind: "metric_single", metric: "damage" },
  { key: "p_dmg_2000", tier: "premium", reward: 30, target: 2000, kind: "metric_single", metric: "damage" },
  { key: "p_hs_8", tier: "premium", reward: 24, target: 8, kind: "metric_single", metric: "hs_kills" },
  { key: "p_assists_10", tier: "premium", reward: 18, target: 10, kind: "metric_single", metric: "assists" },
  { key: "p_flash_5", tier: "premium", reward: 16, target: 5, kind: "metric_single", metric: "enemies_flashed" },
  { key: "p_3k_1", tier: "premium", reward: 20, target: 1, kind: "metric_single", metric: "three_kill_rounds" },
  { key: "p_knife_1", tier: "premium", reward: 25, target: 1, kind: "metric_single", metric: "knife_kills" },
  { key: "p_kd_12", tier: "premium", reward: 22, target: 120, kind: "metric_single", metric: "kd_ratio" },
  { key: "p_adr_80", tier: "premium", reward: 22, target: 80, kind: "metric_single", metric: "adr" },
  { key: "p_kills_day_40", tier: "premium", reward: 32, target: 40, kind: "metric_day", metric: "kills" },
  { key: "p_dmg_day_3000", tier: "premium", reward: 32, target: 3000, kind: "metric_day", metric: "damage" },

  // —— Premium Plus (20) ——
  { key: "pp_win_comp_2", tier: "premium_plus", reward: 35, target: 2, kind: "win_matches", matchType: "Competitive" },
  { key: "pp_win_comp_3", tier: "premium_plus", reward: 50, target: 3, kind: "win_matches", matchType: "Competitive" },
  { key: "pp_win_wing_2", tier: "premium_plus", reward: 32, target: 2, kind: "win_matches", matchType: "Wingman" },
  { key: "pp_win_duel_2", tier: "premium_plus", reward: 32, target: 2, kind: "win_matches", matchType: "Duel" },
  { key: "pp_win_any_3", tier: "premium_plus", reward: 45, target: 3, kind: "win_matches" },
  { key: "pp_play_5", tier: "premium_plus", reward: 30, target: 5, kind: "play_matches" },
  { key: "pp_kills_30", tier: "premium_plus", reward: 40, target: 30, kind: "metric_single", metric: "kills" },
  { key: "pp_kills_35", tier: "premium_plus", reward: 48, target: 35, kind: "metric_single", metric: "kills" },
  { key: "pp_dmg_2500", tier: "premium_plus", reward: 40, target: 2500, kind: "metric_single", metric: "damage" },
  { key: "pp_dmg_3000", tier: "premium_plus", reward: 50, target: 3000, kind: "metric_single", metric: "damage" },
  { key: "pp_hs_12", tier: "premium_plus", reward: 42, target: 12, kind: "metric_single", metric: "hs_kills" },
  { key: "pp_ace_1", tier: "premium_plus", reward: 55, target: 1, kind: "metric_single", metric: "five_kill_rounds" },
  { key: "pp_4k_2", tier: "premium_plus", reward: 45, target: 2, kind: "metric_single", metric: "four_kill_rounds" },
  { key: "pp_3k_3", tier: "premium_plus", reward: 40, target: 3, kind: "metric_single", metric: "three_kill_rounds" },
  { key: "pp_flash_10", tier: "premium_plus", reward: 28, target: 10, kind: "metric_single", metric: "enemies_flashed" },
  { key: "pp_trade_10", tier: "premium_plus", reward: 35, target: 10, kind: "metric_single", metric: "trade_kill_successes" },
  { key: "pp_kd_15", tier: "premium_plus", reward: 38, target: 150, kind: "metric_single", metric: "kd_ratio" },
  { key: "pp_adr_100", tier: "premium_plus", reward: 38, target: 100, kind: "metric_single", metric: "adr" },
  { key: "pp_kast_80", tier: "premium_plus", reward: 36, target: 80, kind: "metric_single", metric: "kast_pct" },
  { key: "pp_kills_day_60", tier: "premium_plus", reward: 55, target: 60, kind: "metric_day", metric: "kills" },
];

export function challengesForTier(tier: ChallengeTier): ChallengeDef[] {
  return CHALLENGE_CATALOG.filter((c) => c.tier === tier);
}

export function getChallenge(key: string): ChallengeDef | undefined {
  return CHALLENGE_CATALOG.find((c) => c.key === key);
}

/** Stable pick of `count` challenges for a player/day/tier. */
export function pickDailyChallenges(
  steamId: string,
  day: string,
  tier: ChallengeTier,
  count = 2,
): ChallengeDef[] {
  const pool = challengesForTier(tier);
  if (pool.length === 0) return [];
  const seed = hashString(`${steamId}|${day}|${tier}`);
  const order = pool
    .map((c, i) => ({ c, score: hashString(`${seed}|${c.key}|${i}`) }))
    .sort((a, b) => a.score - b.score);
  return order.slice(0, Math.min(count, order.length)).map((x) => x.c);
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
