/** Club member rank ladder (1–10). Role is derived from level. */

export const CLUB_LEVEL_MIN = 1;
export const CLUB_LEVEL_MAX = 10;
export const CLUB_AUTO_LEVEL_MAX = 6;
export const CLUB_STAFF_LEVEL_MIN = 7;

/** XP needed for auto levels 2–6 (club-server play + challenge completions). */
export const CLUB_XP_THRESHOLDS: Record<number, number> = {
  2: 150,
  3: 400,
  4: 800,
  5: 1500,
  6: 3000,
};

/** XP awarded when a club challenge is completed, by catalog difficulty. */
export const CLUB_CHALLENGE_XP: Record<string, number> = {
  easy: 25,
  medium: 50,
  hard: 100,
  elite: 200,
  legendary: 400,
};

export const CLUB_PERM_KEYS = [
  "post_news",
  "moderate_news",
  "manage_members",
  "manage_invites",
  "manage_requests",
  "manage_bans",
  "manage_servers",
  "manage_challenges",
  "manage_settings",
  "manage_levels",
  "set_titles",
  "set_staff_level",
] as const;

export type ClubPermKey = (typeof CLUB_PERM_KEYS)[number];

export const DEFAULT_LEVEL_PERMISSIONS: Record<
  ClubPermKey,
  { min: number }
> = {
  post_news: { min: 8 },
  moderate_news: { min: 8 },
  manage_members: { min: 8 },
  manage_invites: { min: 8 },
  manage_requests: { min: 8 },
  manage_bans: { min: 8 },
  manage_servers: { min: 8 },
  manage_challenges: { min: 8 },
  manage_settings: { min: 9 },
  manage_levels: { min: 10 },
  set_titles: { min: 10 },
  set_staff_level: { min: 10 },
};

export function roleFromLevel(level: number): string {
  if (level >= 10) return "owner";
  if (level === 9) return "co_owner";
  if (level === 8) return "admin";
  return "member";
}

export function autoLevelFromVipAndXp(opts: {
  vipServerCount: number;
  clubServerCount: number;
  hasClubVip: boolean;
  xp: number;
}): number {
  let vipLevel = 1;
  if (opts.hasClubVip || (opts.clubServerCount > 0 && opts.vipServerCount >= opts.clubServerCount)) {
    vipLevel = 5;
  } else if (opts.vipServerCount >= 3) {
    vipLevel = 4;
  } else if (opts.vipServerCount >= 2) {
    vipLevel = 3;
  } else if (opts.vipServerCount >= 1) {
    vipLevel = 2;
  }

  let xpLevel = 1;
  for (let lvl = CLUB_AUTO_LEVEL_MAX; lvl >= 2; lvl--) {
    if (opts.xp >= (CLUB_XP_THRESHOLDS[lvl] ?? Number.POSITIVE_INFINITY)) {
      xpLevel = lvl;
      break;
    }
  }

  // Club-wide VIP + enough XP → 6
  if (vipLevel >= 5 && opts.xp >= CLUB_XP_THRESHOLDS[6] / 2) {
    vipLevel = 6;
  }

  return Math.min(CLUB_AUTO_LEVEL_MAX, Math.max(vipLevel, xpLevel));
}

export function effectiveLevel(opts: {
  staffLevel: number | null | undefined;
  autoLevel: number;
  isOwner: boolean;
}): number {
  if (opts.isOwner) return 10;
  const staff = opts.staffLevel;
  if (staff != null && staff >= CLUB_STAFF_LEVEL_MIN && staff <= CLUB_LEVEL_MAX) {
    return staff;
  }
  return Math.min(CLUB_AUTO_LEVEL_MAX, Math.max(CLUB_LEVEL_MIN, opts.autoLevel));
}

export function challengeXpForDifficulty(difficulty: string | null | undefined) {
  const key = String(difficulty || "medium").toLowerCase();
  return CLUB_CHALLENGE_XP[key] ?? CLUB_CHALLENGE_XP.medium;
}

type LevelPermRule = {
  min?: number;
  levels?: Record<string, boolean>;
};

export function permissionAllowed(opts: {
  level: number;
  perm: ClubPermKey;
  clubPermissions: Record<string, LevelPermRule> | null | undefined;
  override: boolean | null | undefined;
}): boolean {
  if (opts.override === true) return true;
  if (opts.override === false) return false;

  const configured = opts.clubPermissions?.[opts.perm] as LevelPermRule | undefined;
  const fallback = DEFAULT_LEVEL_PERMISSIONS[opts.perm];
  const levelMap = configured?.levels;
  if (
    levelMap &&
    Object.prototype.hasOwnProperty.call(levelMap, String(opts.level))
  ) {
    return !!levelMap[String(opts.level)];
  }
  const min = Number(configured?.min ?? fallback.min);
  return opts.level >= min;
}
