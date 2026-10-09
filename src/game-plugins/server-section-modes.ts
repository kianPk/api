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
  // The first map; the server boots straight into it instead of de_dust2.
  extraGameParams: string;
  plugins: Array<ServerSectionPlugin>;
};

// MapChooser runs the end-of-map vote and the rotation, so each cfg hands the
// end of the match to it rather than to Valve's vote.
const HAND_END_OF_MATCH_TO_MAPCHOOSER = [
  "mp_endmatch_votenextmap 0",
  "mp_match_end_changelevel 0",
  "mp_match_end_restart 1",
];

const TIMED_MAP = [
  "mp_timelimit 20",
  "mp_maxrounds 0",
  "mp_halftime 0",
  "mp_match_can_clinch 0",
  "mp_warmuptime 10",
];

const NO_BOTS = ["bot_quota 0", "mp_autokick 0"];

// MapChooser keeps its map list in maps.jsonc, written beside config.jsonc
// through "__files". Workshop maps go by id.
function mapChooser(
  maps: Array<{ name: string; id: string }>,
  mapsToShow: number,
): ServerSectionPlugin {
  return {
    slug: "map-chooser",
    required: false,
    config: {
      MapChooser: {
        MapsInCooldown: 1,
        Cycle: { Enabled: true, RandomOrder: false },
        EndOfMap: { Enabled: true, MapsToShow: mapsToShow },
      },
      __files: {
        "maps.jsonc": {
          MapChooserMaps: {
            Maps: maps.map((map) => ({ Name: map.name, Id: map.id })),
          },
        },
      },
    },
  };
}

export const SERVER_SECTION_MODES: Record<
  ServerSectionModeKey,
  ServerSectionMode
> = {
  // xplay's own duels_* maps are not public, so Duels rotates the most-played
  // CS2 arena maps instead.
  duels: {
    key: "duels",
    label: "Duels",
    type: "Casual",
    maxPlayers: 18,
    cfg: [...TIMED_MAP, ...NO_BOTS, ...HAND_END_OF_MATCH_TO_MAPCHOOSER].join(
      "\n",
    ),
    extraGameParams: "+host_workshop_map 3145424712",
    plugins: [
      { slug: "arenas", required: true, config: null },
      mapChooser(
        [
          { name: "Mirage Duels", id: "3145424712" },
          { name: "Redline", id: "3139172262" },
          { name: "Anubis Duels", id: "3242420753" },
          { name: "Forgotten Yard", id: "3356301765" },
        ],
        4,
      ),
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
      ...HAND_END_OF_MATCH_TO_MAPCHOOSER,
    ].join("\n"),
    extraGameParams: "+host_workshop_map 3077655898",
    plugins: [
      mapChooser(
        [
          { name: "awp_lego_2", id: "3077655898" },
          { name: "awp_creek", id: "3081154235" },
          { name: "awp_roost_fp", id: "3070577601" },
          { name: "awp_gony_v2", id: "3094723224" },
        ],
        4,
      ),
    ],
  },
  "2x2": {
    key: "2x2",
    label: "2x2",
    type: "Wingman",
    maxPlayers: 4,
    cfg: [...NO_BOTS, ...HAND_END_OF_MATCH_TO_MAPCHOOSER].join("\n"),
    extraGameParams: "+map de_inferno",
    plugins: [
      mapChooser(
        [
          { name: "Inferno", id: "de_inferno" },
          { name: "Nuke", id: "de_nuke" },
          { name: "Overpass", id: "de_overpass" },
          { name: "Vertigo", id: "de_vertigo" },
          { name: "Poseidon", id: "3522144043" },
        ],
        5,
      ),
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
