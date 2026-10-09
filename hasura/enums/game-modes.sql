-- Starter modes, seeded on every boot so a fresh install has something to pick
-- besides "Competitive". Enum-style upsert: the name and description follow the
-- ship, but enabled / competitive_safe / cfg are left alone once an operator has
-- touched them, and anything they add of their own is untouched.
--
-- Runtime compatibility is NOT declared here. It is derived from the plugins
-- each mode selects, so a mode whose plugin has no build for this deployment
-- reports that by name rather than booting a server with nothing loaded.
insert into game_modes (slug, name, description, competitive_safe, enabled, cfg)
values
    (
        'retakes',
        'Retakes',
        'Bombsite retakes: the bomb is planted, T''s defend, CT''s retake. Fast rounds, no buy time.',
        false,
        true,
        'mp_maxrounds 0' || chr(10) ||
        'mp_freezetime 3' || chr(10) ||
        'mp_round_restart_delay 3' || chr(10) ||
        'mp_ignore_round_win_conditions 1' || chr(10) ||
        'mp_respawn_on_death_ct 0' || chr(10) ||
        'mp_respawn_on_death_t 0'
    ),
    (
        'deathmatch',
        'Deathmatch',
        'Free-for-all warmup with instant respawns and a weapon menu.',
        false,
        true,
        'mp_maxrounds 0' || chr(10) ||
        'mp_freezetime 0' || chr(10) ||
        'mp_respawn_immunitytime 2' || chr(10) ||
        'mp_ignore_round_win_conditions 1' || chr(10) ||
        'mp_teammates_are_enemies 1'
    )
on conflict (slug) do update set
    name = excluded.name,
    description = excluded.description;

-- Wire each starter mode to its plugin, but only once that plugin is in the
-- catalog: the registry syncs on its own schedule, so on a first boot these
-- modes exist with no plugins and pick them up on a later pass.
insert into game_mode_plugins (game_mode_id, plugin_slug, load_order)
select m.id, p.slug, 0
  from game_modes m
  join game_plugins p on p.slug = m.slug
 where m.slug in ('retakes', 'deathmatch')
on conflict (game_mode_id, plugin_slug) do nothing;

-- The public-server modes the Servers page lists, with the maps and in-game
-- rules xplay.gg runs them with. A server joins one by being assigned to it;
-- its type stays the operator's (Casual for Duels and AWP, Wingman for 2x2).
-- extra_game_params names the first map, which the server boots into instead
-- of de_dust2. MapChooser runs the end-of-map vote and the rotation, so each
-- cfg hands the end of the match to it.
insert into game_modes (slug, name, description, competitive_safe, enabled, cfg, extra_game_params)
values
    (
        'duels',
        'Duels',
        'Compete in the arena with other players in 1v1 format and climb the ranks!',
        false,
        true,
        'mp_timelimit 20' || chr(10) ||
        'mp_maxrounds 0' || chr(10) ||
        'mp_halftime 0' || chr(10) ||
        'mp_match_can_clinch 0' || chr(10) ||
        'mp_warmuptime 10' || chr(10) ||
        'bot_quota 0' || chr(10) ||
        'mp_autokick 0' || chr(10) ||
        'mp_endmatch_votenextmap 0' || chr(10) ||
        'mp_match_end_changelevel 0' || chr(10) ||
        'mp_match_end_restart 1',
        '+host_workshop_map 3145424712'
    ),
    (
        'awp',
        'AWP',
        'Enhance your AWP skills by training flickshots and noscopes and become a world-class sniper.',
        false,
        true,
        'mp_t_default_primary "weapon_awp"' || chr(10) ||
        'mp_ct_default_primary "weapon_awp"' || chr(10) ||
        'mp_t_default_secondary ""' || chr(10) ||
        'mp_ct_default_secondary ""' || chr(10) ||
        'mp_free_armor 1' || chr(10) ||
        'mp_startmoney 0' || chr(10) ||
        'mp_maxmoney 0' || chr(10) ||
        'mp_afterroundmoney 0' || chr(10) ||
        'mp_buytime 0' || chr(10) ||
        'mp_buy_anywhere 0' || chr(10) ||
        'mp_weapons_allow_map_placed 0' || chr(10) ||
        'mp_death_drop_gun 0' || chr(10) ||
        'mp_death_drop_grenade 0' || chr(10) ||
        'mp_death_drop_defuser 0' || chr(10) ||
        'sv_infinite_ammo 2' || chr(10) ||
        'mp_freezetime 1' || chr(10) ||
        'mp_roundtime 1.5' || chr(10) ||
        'mp_round_restart_delay 3' || chr(10) ||
        'mp_timelimit 20' || chr(10) ||
        'mp_maxrounds 0' || chr(10) ||
        'mp_halftime 0' || chr(10) ||
        'mp_match_can_clinch 0' || chr(10) ||
        'mp_warmuptime 10' || chr(10) ||
        'mp_solid_teammates 1' || chr(10) ||
        'bot_quota 0' || chr(10) ||
        'mp_autokick 0' || chr(10) ||
        'mp_endmatch_votenextmap 0' || chr(10) ||
        'mp_match_end_changelevel 0' || chr(10) ||
        'mp_match_end_restart 1',
        '+host_workshop_map 3077655898'
    ),
    (
        '2x2',
        '2x2',
        'Classic Wingman from CS2. Practice in 2v2 mode with your friend.',
        false,
        true,
        'bot_quota 0' || chr(10) ||
        'mp_autokick 0' || chr(10) ||
        'mp_endmatch_votenextmap 0' || chr(10) ||
        'mp_match_end_changelevel 0' || chr(10) ||
        'mp_match_end_restart 1',
        '+map de_inferno'
    )
on conflict (slug) do update set
    name = excluded.name,
    description = excluded.description;

-- MapChooser keeps its map list in maps.jsonc, written beside config.jsonc
-- through "__files". Workshop maps go by id; xplay's own duels_* maps are
-- not public, so Duels rotates the most-played CS2 arena maps instead.
insert into game_mode_plugins (game_mode_id, plugin_slug, load_order, config, required)
select m.id, p.plugin_slug, p.load_order, p.config::jsonb, p.required
  from game_modes m
  join (values
    ('duels', 'arenas', 0, null, true),
    ('duels', 'map-chooser', 10, '{
      "MapChooser": {
        "MapsInCooldown": 1,
        "Cycle": { "Enabled": true, "RandomOrder": false },
        "EndOfMap": { "Enabled": true, "MapsToShow": 4 }
      },
      "__files": {
        "maps.jsonc": {
          "MapChooserMaps": {
            "Maps": [
              { "Name": "Mirage Duels", "Id": "3145424712" },
              { "Name": "Redline", "Id": "3139172262" },
              { "Name": "Anubis Duels", "Id": "3242420753" },
              { "Name": "Forgotten Yard", "Id": "3356301765" }
            ]
          }
        }
      }
    }', false),
    ('awp', 'map-chooser', 10, '{
      "MapChooser": {
        "MapsInCooldown": 1,
        "Cycle": { "Enabled": true, "RandomOrder": false },
        "EndOfMap": { "Enabled": true, "MapsToShow": 4 }
      },
      "__files": {
        "maps.jsonc": {
          "MapChooserMaps": {
            "Maps": [
              { "Name": "awp_lego_2", "Id": "3077655898" },
              { "Name": "awp_creek", "Id": "3081154235" },
              { "Name": "awp_roost_fp", "Id": "3070577601" },
              { "Name": "awp_gony_v2", "Id": "3094723224" }
            ]
          }
        }
      }
    }', false),
    ('2x2', 'map-chooser', 10, '{
      "MapChooser": {
        "MapsInCooldown": 1,
        "Cycle": { "Enabled": true, "RandomOrder": false },
        "EndOfMap": { "Enabled": true, "MapsToShow": 5 }
      },
      "__files": {
        "maps.jsonc": {
          "MapChooserMaps": {
            "Maps": [
              { "Name": "Inferno", "Id": "de_inferno" },
              { "Name": "Nuke", "Id": "de_nuke" },
              { "Name": "Overpass", "Id": "de_overpass" },
              { "Name": "Vertigo", "Id": "de_vertigo" },
              { "Name": "Poseidon", "Id": "3522144043" }
            ]
          }
        }
      }
    }', false)
  ) as p(mode_slug, plugin_slug, load_order, config, required)
    on p.mode_slug = m.slug
 where exists (select 1 from game_plugins gp where gp.slug = p.plugin_slug)
on conflict (game_mode_id, plugin_slug) do nothing;
