export const SEASON_LENGTH_DAYS = 60;
export const MAX_LEVEL = 50;
export const XP_PER_LEVEL = 1000;
export const DEFAULT_PREMIUM_PRICE_YPOINTS = 600;

export const MATCH_XP = 100;
export const MATCH_WIN_XP = 50;
// Caps farming: only the first N qualifying matches of a Tehran day earn match XP.
export const MATCH_XP_DAILY_CAP = 6;
export const MATCH_MIN_ROUNDS = 3;

export const DAILY_MISSION_COUNT = 3;
export const WEEKLY_MISSION_COUNT = 3;

export const SUBSCRIBER_CHALLENGE_XP: Record<string, number> = {
  premium: 250,
  premium_plus: 350,
};

export type Track = "free" | "premium";

export type BadgeKey =
  | "veteran"
  | "elite"
  | "legend"
  | "premium"
  | "contender"
  | "champion";

export type Reward =
  | { type: "ypoints"; amount: number }
  | { type: "xp"; amount: number }
  | { type: "subscription"; tier: "premium" | "premium_plus"; days: number }
  | { type: "badge"; badge: BadgeKey };

export const BADGES: Record<
  BadgeKey,
  { name: string; description: string; silhouette: number }
> = {
  contender: {
    name: "Battle Pass S{season} Contender",
    description: "Reached level 10 of Battle Pass season {season}.",
    silhouette: 0,
  },
  veteran: {
    name: "Battle Pass S{season} Veteran",
    description: "Reached level 25 of Battle Pass season {season}.",
    silhouette: 1,
  },
  champion: {
    name: "Battle Pass S{season} Champion",
    description: "Reached level 40 of Battle Pass season {season}.",
    silhouette: 2,
  },
  elite: {
    name: "Battle Pass S{season} Elite",
    description: "Reached level 50 of Battle Pass season {season}.",
    silhouette: 3,
  },
  legend: {
    name: "Battle Pass S{season} Legend",
    description: "Completed the Premium track of Battle Pass season {season}.",
    silhouette: 4,
  },
  // Shown next to the buyer's profile for the season they unlocked Premium.
  premium: {
    name: "Battle Pass S{season}",
    description: "Unlocked the Premium Battle Pass for season {season}.",
    silhouette: 5,
  },
};

// Free track: mixed rewards like xplay (not Ypoints-only).
const FREE_REWARDS: Record<number, Reward> = {
  3: { type: "xp", amount: 200 },
  5: { type: "ypoints", amount: 15 },
  8: { type: "subscription", tier: "premium", days: 1 },
  10: { type: "badge", badge: "contender" },
  12: { type: "xp", amount: 300 },
  15: { type: "ypoints", amount: 25 },
  18: { type: "subscription", tier: "premium", days: 2 },
  20: { type: "xp", amount: 400 },
  25: { type: "badge", badge: "veteran" },
  28: { type: "ypoints", amount: 35 },
  30: { type: "subscription", tier: "premium", days: 3 },
  35: { type: "xp", amount: 500 },
  40: { type: "badge", badge: "champion" },
  45: { type: "ypoints", amount: 50 },
  50: { type: "badge", badge: "elite" },
};

const PREMIUM_SPECIAL: Record<number, Reward> = {
  1: { type: "ypoints", amount: 20 },
  5: { type: "xp", amount: 350 },
  7: { type: "subscription", tier: "premium", days: 3 },
  10: { type: "subscription", tier: "premium", days: 7 },
  12: { type: "ypoints", amount: 40 },
  15: { type: "xp", amount: 500 },
  18: { type: "badge", badge: "contender" },
  20: { type: "subscription", tier: "premium", days: 7 },
  22: { type: "ypoints", amount: 50 },
  25: { type: "badge", badge: "veteran" },
  28: { type: "xp", amount: 600 },
  30: { type: "subscription", tier: "premium_plus", days: 7 },
  32: { type: "ypoints", amount: 60 },
  35: { type: "xp", amount: 750 },
  38: { type: "subscription", tier: "premium_plus", days: 5 },
  40: { type: "badge", badge: "champion" },
  42: { type: "ypoints", amount: 80 },
  45: { type: "subscription", tier: "premium_plus", days: 7 },
  48: { type: "xp", amount: 1000 },
  50: { type: "badge", badge: "legend" },
};

export function rewardFor(level: number, track: Track): Reward | null {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    return null;
  }
  if (track === "free") {
    return FREE_REWARDS[level] ?? null;
  }
  if (PREMIUM_SPECIAL[level]) {
    return PREMIUM_SPECIAL[level];
  }
  // Premium filler: rotate ypoints / XP packs so it is not currency-only.
  if (level % 4 === 0) {
    return { type: "xp", amount: 150 + level * 5 };
  }
  if (level % 3 === 0) {
    return { type: "ypoints", amount: 12 + Math.floor(level / 5) };
  }
  return { type: "ypoints", amount: 10 };
}

export function levelForXp(xp: number): number {
  return Math.min(MAX_LEVEL, Math.floor(Math.max(0, xp) / XP_PER_LEVEL));
}

export type MissionStat =
  | "kills"
  | "hs_kills"
  | "damage"
  | "assists"
  | "enemies_flashed"
  | "he_damage"
  | "three_kill_rounds"
  | "trade_kill_successes";

export type MissionDef = {
  key: string;
  xp: number;
  target: number;
  kind: "play" | "win" | "sum" | "best";
  stat?: MissionStat;
  matchType?: "Competitive" | "Wingman" | "Duel" | "Rush";
};

// Harder daily pool: fewer easy one-and-dones, higher kill/damage bars.
export const DAILY_MISSIONS: MissionDef[] = [
  { key: "d_play_2", xp: 200, target: 2, kind: "play" },
  { key: "d_play_3", xp: 300, target: 3, kind: "play" },
  { key: "d_win_1", xp: 220, target: 1, kind: "win" },
  { key: "d_win_2", xp: 350, target: 2, kind: "win" },
  { key: "d_kills_25", xp: 220, target: 25, kind: "sum", stat: "kills" },
  { key: "d_kills_40", xp: 320, target: 40, kind: "sum", stat: "kills" },
  { key: "d_hs_12", xp: 240, target: 12, kind: "sum", stat: "hs_kills" },
  { key: "d_hs_18", xp: 320, target: 18, kind: "sum", stat: "hs_kills" },
  { key: "d_dmg_2200", xp: 220, target: 2200, kind: "sum", stat: "damage" },
  { key: "d_dmg_3200", xp: 320, target: 3200, kind: "sum", stat: "damage" },
  { key: "d_assists_10", xp: 180, target: 10, kind: "sum", stat: "assists" },
  {
    key: "d_flash_10",
    xp: 180,
    target: 10,
    kind: "sum",
    stat: "enemies_flashed",
  },
  { key: "d_he_250", xp: 180, target: 250, kind: "sum", stat: "he_damage" },
  {
    key: "d_3k_2",
    xp: 300,
    target: 2,
    kind: "best",
    stat: "three_kill_rounds",
  },
];

export const WEEKLY_MISSIONS: MissionDef[] = [
  { key: "w_play_14", xp: 1400, target: 14, kind: "play" },
  { key: "w_win_8", xp: 1700, target: 8, kind: "win" },
  { key: "w_duel_5", xp: 1200, target: 5, kind: "play", matchType: "Duel" },
  { key: "w_kills_160", xp: 1400, target: 160, kind: "sum", stat: "kills" },
  { key: "w_hs_70", xp: 1400, target: 70, kind: "sum", stat: "hs_kills" },
  { key: "w_dmg_14000", xp: 1400, target: 14000, kind: "sum", stat: "damage" },
  {
    key: "w_3k_8",
    xp: 1500,
    target: 8,
    kind: "sum",
    stat: "three_kill_rounds",
  },
  {
    key: "w_flash_50",
    xp: 1200,
    target: 50,
    kind: "sum",
    stat: "enemies_flashed",
  },
  {
    key: "w_trade_25",
    xp: 1200,
    target: 25,
    kind: "sum",
    stat: "trade_kill_successes",
  },
];

export type SeasonMatch = {
  match_id: string;
  type: string | null;
  day: string;
  won: boolean;
  rounds_played: number;
} & Record<MissionStat, number>;

export function pickMissions(
  pool: MissionDef[],
  seed: string,
  count: number,
): MissionDef[] {
  return pool
    .map((mission, index) => ({
      mission,
      score: hashString(`${seed}|${mission.key}|${index}`),
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, Math.min(count, pool.length))
    .map(({ mission }) => mission);
}

export function missionProgress(
  mission: MissionDef,
  matches: SeasonMatch[],
): number {
  const eligible = matches.filter(
    (match) => !mission.matchType || match.type === mission.matchType,
  );
  switch (mission.kind) {
    case "play":
      return eligible.length;
    case "win":
      return eligible.filter((match) => match.won).length;
    case "sum":
      return eligible.reduce((sum, match) => sum + match[mission.stat], 0);
    case "best":
      return eligible.reduce(
        (best, match) => Math.max(best, match[mission.stat]),
        0,
      );
  }
}

export function matchXp(matches: SeasonMatch[]): number {
  const perDay = new Map<string, number>();
  let xp = 0;
  for (const match of matches) {
    if (match.rounds_played < MATCH_MIN_ROUNDS) {
      continue;
    }
    const counted = perDay.get(match.day) ?? 0;
    if (counted >= MATCH_XP_DAILY_CAP) {
      continue;
    }
    perDay.set(match.day, counted + 1);
    xp += MATCH_XP + (match.won ? MATCH_WIN_XP : 0);
  }
  return xp;
}

/** Iranian weeks start on Saturday. */
export function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const sinceSaturday = (date.getUTCDay() + 1) % 7;
  date.setUTCDate(date.getUTCDate() - sinceSaturday);
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
