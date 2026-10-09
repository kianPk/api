// The Servers section's modes. They are not game modes: nothing in the
// operator's mode catalog, match options or the server form can pick them, and
// their rules, maps and plugins live here so every server of a mode boots
// identically. The servers themselves are created by ServersSectionService
// from a per-mode count.
//
// The database mirrors type and max_players in tbiu_servers_section_mode,
// which forces them on every write; keep the two in step.

export type ServerSectionModeKey = "duels" | "awp" | "2x2";

export type ServerSectionPlugin = {
  slug: string;
  required: boolean;
  config: Record<string, unknown> | null;
};

export type ServerSectionMode = {
  key: ServerSectionModeKey;
  label: string;
  type: "Casual" | "Wingman";
  maxPlayers: number;
  cfg: string;
  // The map the server boots into.
  extraGameParams: string;
  plugins: Array<ServerSectionPlugin>;
};

// Each mode's own plugin (kianPk/ServersModes) runs the map vote and the
// rotation, so each cfg hands the end of the match to it rather than to
// Valve's vote, and leaves it time to change the map.
const HAND_END_OF_MATCH_TO_PLUGIN = [
  "mp_endmatch_votenextmap 0",
  "mp_match_end_changelevel 0",
  "mp_match_end_restart 1",
  "mp_match_restart_delay 30",
];

const TIMED_MAP = [
  "mp_timelimit 20",
  "mp_maxrounds 0",
  "mp_halftime 0",
  "mp_match_can_clinch 0",
  "mp_warmuptime 10",
];

const NO_BOTS = ["bot_quota 0", "mp_autokick 0"];

// CS2 logs into Steam only once a map has loaded, and a workshop map cannot
// download before that: booting straight into +host_workshop_map hangs the
// server forever. So a workshop mode boots on a stock map and its plugin moves
// it onto the mode's pool, which is why that plugin is required.
const WORKSHOP_BOOT_MAP = "+map de_dust2";

// A mode's plugin carries its rules, map pool and vote in code, so it takes
// no config. Skins are the one thing shared with the rest of the site.
const INVENTORY: ServerSectionPlugin = {
  slug: "inventory-simulator",
  required: false,
  config: null,
};

export const SERVER_SECTION_PLUGIN_SLUGS = [
  "servers-duels",
  "servers-awp",
  "servers-2x2",
];

export const SERVER_SECTION_MODES: Record<
  ServerSectionModeKey,
  ServerSectionMode
> = {
  // xplay's own duels_* maps are not public, so Duels rotates the most-played
  // CS2 arena maps instead. The plugin owns teams, spawns and loadouts: it
  // pairs players into arenas, ends the round once every arena is decided and
  // hands out the weapons each player picked with !guns.
  duels: {
    key: "duels",
    label: "Duels",
    type: "Casual",
    maxPlayers: 18,
    cfg: [
      'mp_t_default_secondary ""',
      'mp_ct_default_secondary ""',
      "mp_startmoney 0",
      "mp_maxmoney 0",
      "mp_afterroundmoney 0",
      "mp_buytime 0",
      "mp_buy_anywhere 0",
      "mp_weapons_allow_map_placed 0",
      "mp_death_drop_gun 0",
      "mp_death_drop_grenade 0",
      "mp_death_drop_defuser 0",
      "sv_infinite_ammo 2",
      "mp_freezetime 2",
      "mp_roundtime 1.5",
      "mp_round_restart_delay 3",
      "mp_autoteambalance 0",
      "mp_limitteams 0",
      "mp_force_assign_teams 1",
      "mp_friendlyfire 0",
      "mp_solid_teammates 1",
      ...TIMED_MAP,
      ...NO_BOTS,
      ...HAND_END_OF_MATCH_TO_PLUGIN,
    ].join("\n"),
    extraGameParams: WORKSHOP_BOOT_MAP,
    plugins: [
      { slug: "servers-duels", required: true, config: null },
      INVENTORY,
    ],
  },
  awp: {
    key: "awp",
    label: "AWP",
    type: "Casual",
    maxPlayers: 20,
    cfg: [
      'mp_t_default_primary "weapon_awp"',
      'mp_ct_default_primary "weapon_awp"',
      'mp_t_default_secondary ""',
      'mp_ct_default_secondary ""',
      "mp_free_armor 1",
      "mp_startmoney 0",
      "mp_maxmoney 0",
      "mp_afterroundmoney 0",
      "mp_buytime 0",
      "mp_buy_anywhere 0",
      "mp_weapons_allow_map_placed 0",
      "mp_death_drop_gun 0",
      "mp_death_drop_grenade 0",
      "mp_death_drop_defuser 0",
      "sv_infinite_ammo 2",
      "mp_freezetime 1",
      "mp_roundtime 1.5",
      "mp_round_restart_delay 3",
      ...TIMED_MAP,
      "mp_solid_teammates 1",
      ...NO_BOTS,
      ...HAND_END_OF_MATCH_TO_PLUGIN,
    ].join("\n"),
    extraGameParams: WORKSHOP_BOOT_MAP,
    plugins: [{ slug: "servers-awp", required: true, config: null }, INVENTORY],
  },
  "2x2": {
    key: "2x2",
    label: "2x2",
    type: "Wingman",
    maxPlayers: 4,
    cfg: [...NO_BOTS, ...HAND_END_OF_MATCH_TO_PLUGIN].join("\n"),
    extraGameParams: "+map de_inferno",
    plugins: [
      { slug: "servers-2x2", required: false, config: null },
      INVENTORY,
    ],
  },
};

export function isServerSectionMode(
  value: unknown,
): value is ServerSectionModeKey {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SERVER_SECTION_MODES, value)
  );
}
