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

export type BadgeKey = "veteran" | "elite" | "legend" | "premium";

export type Reward =
  | { type: "ypoints"; amount: number }
  | { type: "subscription"; tier: "premium" | "premium_plus"; days: number }
  | { type: "badge"; badge: BadgeKey };

export const BADGES: Record<
  BadgeKey,
  { name: string; description: string; silhouette: number }
> = {
  veteran: {
    name: "Battle Pass S{season} Veteran",
    description: "Reached level 25 of Battle Pass season {season}.",
    silhouette: 1,
  },
  elite: {
    name: "Battle Pass S{season} Elite",
    description: "Reached level 50 of Battle Pass season {season}.",
    silhouette: 2,
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
    silhouette: 3,
  },
};

const FREE_REWARDS: Record<number, Reward> = {
  5: { type: "ypoints", amount: 15 },
  10: { type: "ypoints", amount: 20 },
  15: { type: "ypoints", amount: 25 },
  20: { type: "ypoints", amount: 30 },
  25: { type: "badge", badge: "veteran" },
  30: { type: "ypoints", amount: 35 },
  35: { type: "ypoints", amount: 40 },
  40: { type: "ypoints", amount: 45 },
  45: { type: "ypoints", amount: 50 },
  50: { type: "badge", badge: "elite" },
};

const PREMIUM_SPECIAL: Record<number, Reward> = {
  10: { type: "subscription", tier: "premium", days: 7 },
  20: { type: "subscription", tier: "premium", days: 7 },
  30: { type: "subscription", tier: "premium_plus", days: 7 },
  40: { type: "subscription", tier: "premium_plus", days: 7 },
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
  return { type: "ypoints", amount: level % 5 === 0 ? 30 : 10 };
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

export const DAILY_MISSIONS: MissionDef[] = [
  { key: "d_play_1", xp: 150, target: 1, kind: "play" },
  { key: "d_play_2", xp: 250, target: 2, kind: "play" },
  { key: "d_win_1", xp: 200, target: 1, kind: "win" },
  { key: "d_kills_15", xp: 200, target: 15, kind: "sum", stat: "kills" },
  { key: "d_kills_30", xp: 300, target: 30, kind: "sum", stat: "kills" },
  { key: "d_hs_8", xp: 200, target: 8, kind: "sum", stat: "hs_kills" },
  { key: "d_dmg_1500", xp: 200, target: 1500, kind: "sum", stat: "damage" },
  { key: "d_assists_6", xp: 150, target: 6, kind: "sum", stat: "assists" },
  {
    key: "d_flash_6",
    xp: 150,
    target: 6,
    kind: "sum",
    stat: "enemies_flashed",
  },
  { key: "d_he_150", xp: 150, target: 150, kind: "sum", stat: "he_damage" },
  {
    key: "d_3k_1",
    xp: 250,
    target: 1,
    kind: "best",
    stat: "three_kill_rounds",
  },
];

export const WEEKLY_MISSIONS: MissionDef[] = [
  { key: "w_play_10", xp: 1200, target: 10, kind: "play" },
  { key: "w_win_5", xp: 1500, target: 5, kind: "win" },
  { key: "w_duel_3", xp: 1000, target: 3, kind: "play", matchType: "Duel" },
  { key: "w_kills_100", xp: 1200, target: 100, kind: "sum", stat: "kills" },
  { key: "w_hs_40", xp: 1200, target: 40, kind: "sum", stat: "hs_kills" },
  { key: "w_dmg_8000", xp: 1200, target: 8000, kind: "sum", stat: "damage" },
  {
    key: "w_3k_5",
    xp: 1300,
    target: 5,
    kind: "sum",
    stat: "three_kill_rounds",
  },
  {
    key: "w_flash_30",
    xp: 1000,
    target: 30,
    kind: "sum",
    stat: "enemies_flashed",
  },
  {
    key: "w_trade_15",
    xp: 1000,
    target: 15,
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
