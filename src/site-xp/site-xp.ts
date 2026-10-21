// One site level for the website and every server. Faceit level stays on the site.
// Bands the owner set: 1000–1500 is 4, 1500–2500 is 5, 2500–4000 is 6, max is 10.
export const SITE_LEVEL_FLOORS = [
  0, 200, 500, 1000, 1500, 2500, 4000, 6000, 8500, 11500,
] as const;

export function siteLevelFromXp(xp: number): number {
  const value = Math.max(0, Math.floor(Number(xp) || 0));
  let level = 1;
  for (let i = 0; i < SITE_LEVEL_FLOORS.length; i++) {
    if (value >= SITE_LEVEL_FLOORS[i]) level = i + 1;
  }
  return level;
}

export function siteXpForLevel(level: number): number {
  const n = Math.min(10, Math.max(1, Math.round(Number(level) || 1)));
  return SITE_LEVEL_FLOORS[n - 1];
}

const UTILITY = new Set([
  "hegrenade",
  "molotov",
  "incgrenade",
  "inferno",
  "decoy",
]);

export function isUtilityWeapon(weapon?: string | null): boolean {
  const name = String(weapon || "")
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, "");
  return UTILITY.has(name);
}

export function isKnifeWeapon(weapon?: string | null): boolean {
  return String(weapon || "")
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, "")
    .startsWith("knife");
}

export type SiteXpKind =
  | "kill"
  | "death"
  | "round_win"
  | "plant"
  | "defuse"
  | "team_damage"
  | "team_kill"
  | "flash_team"
  | "flash_enemy"
  | "utility_damage"
  | "assist"
  | "finish";

export type SiteXpInput = {
  steam_id?: string;
  victim_steam_id?: string | null;
  kind?: string;
  weapon?: string | null;
  headshot?: boolean;
  noscope?: boolean;
  wallbang?: boolean;
  thrusmoke?: boolean;
  blinded?: boolean;
};

export function siteXpDelta(input: SiteXpInput): number {
  switch (String(input.kind || "")) {
    case "death":
      return -10;
    case "team_damage":
      return -10;
    case "team_kill":
      return -20;
    case "flash_team":
      return -5;
    case "flash_enemy":
      return 4;
    case "utility_damage":
      return 10;
    case "plant":
      return 15;
    case "defuse":
      return 20;
    case "round_win":
      return 20;
    case "assist":
      return 5;
    case "finish":
      return 15;
    case "kill": {
      let xp = 10;
      if (input.headshot) xp += 10;
      if (isKnifeWeapon(input.weapon)) xp += 20;
      if (input.noscope) xp += 30;
      if (isUtilityWeapon(input.weapon)) xp += 10;
      if (input.wallbang) xp += 5;
      if (input.thrusmoke) xp += 5;
      if (input.blinded) xp += 5;
      return xp;
    }
    default:
      return 0;
  }
}
