-- Ranked 3v3 (Trios): enum, maps, map pools, CFGs, lineup size, Elo keys, MM toggle

INSERT INTO public.e_match_types ("value", "description") VALUES
  ('Trios', 'Ranked 3 vs 3 competitive matches with full team coordination')
ON CONFLICT ("value") DO UPDATE
  SET "description" = EXCLUDED."description";

INSERT INTO public.e_game_cfg_types ("value", "description") VALUES
  ('Trios', 'Trios (3v3) game configuration')
ON CONFLICT ("value") DO UPDATE
  SET "description" = EXCLUDED."description";

INSERT INTO public.e_map_pool_types ("value", "description") VALUES
  ('Trios', '3 vs 3')
ON CONFLICT ("value") DO UPDATE
  SET "description" = EXCLUDED."description";

-- Reuse Competitive active maps for Trios pool
INSERT INTO public.maps (
  "name", "type", "active_pool", "workshop_map_id", "poster", "patch", "label"
)
SELECT
  m.name,
  'Trios'::text,
  m.active_pool,
  m.workshop_map_id,
  m.poster,
  m.patch,
  m.label
FROM public.maps m
WHERE m.type = 'Competitive'
  AND m.deleted_at IS NULL
ON CONFLICT ("name", "type") DO UPDATE SET
  "active_pool" = EXCLUDED."active_pool",
  "workshop_map_id" = EXCLUDED."workshop_map_id",
  "poster" = EXCLUDED."poster",
  "patch" = EXCLUDED."patch",
  "label" = EXCLUDED."label";

INSERT INTO public.map_pools ("type", "enabled", "seed")
SELECT 'Trios', true, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.map_pools
  WHERE type = 'Trios' AND seed = true AND enabled = true
);

INSERT INTO public._map_pool (map_id, map_pool_id)
SELECT m.id, p.id
FROM public.maps m
JOIN public.map_pools p
  ON p.type = 'Trios' AND p.seed = true AND p.enabled = true
WHERE m.type = 'Trios'
  AND m.active_pool = true
  AND m.deleted_at IS NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_match_type_min_players(match_type TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    IF match_type = 'Competitive' OR match_type = 'Premier' OR match_type = 'Faceit' THEN
        RETURN 5;
    ELSIF match_type = 'Trios' THEN
        RETURN 3;
    ELSIF match_type = 'Wingman' THEN
        RETURN 2;
    ELSIF match_type = 'Duel' THEN
        RETURN 1;
    ELSE
         RAISE EXCEPTION 'Invalid match type: %', match_type USING ERRCODE = '22000';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_player_elo(player public.players) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    _active_season_id UUID;
BEGIN
    IF NOT seasons_enabled() THEN
        return jsonb_build_object(
            'competitive', get_player_elo_by_type(player, 'Competitive'),
            'trios', get_player_elo_by_type(player, 'Trios'),
            'wingman', get_player_elo_by_type(player, 'Wingman'),
            'duel', get_player_elo_by_type(player, 'Duel')
        );
    END IF;

    _active_season_id := get_active_season();

    return jsonb_build_object(
        'competitive', get_player_season_elo_by_type(player, 'Competitive', _active_season_id),
        'trios', get_player_season_elo_by_type(player, 'Trios', _active_season_id),
        'wingman', get_player_season_elo_by_type(player, 'Wingman', _active_season_id),
        'duel', get_player_season_elo_by_type(player, 'Duel', _active_season_id),
        'tournament_competitive', get_player_tournament_elo_by_type(player, 'Competitive'),
        'tournament_trios', get_player_tournament_elo_by_type(player, 'Trios'),
        'tournament_wingman', get_player_tournament_elo_by_type(player, 'Wingman'),
        'tournament_duel', get_player_tournament_elo_by_type(player, 'Duel')
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_player_peak_elo(player public.players) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    return jsonb_build_object(
        'competitive', get_player_peak_elo_by_type(player, 'Competitive'),
        'trios', get_player_peak_elo_by_type(player, 'Trios'),
        'wingman', get_player_peak_elo_by_type(player, 'Wingman'),
        'duel', get_player_peak_elo_by_type(player, 'Duel')
    );
END;
$$;

INSERT INTO public.settings ("name", "value") VALUES
  ('public.matchmaking_trios', 'true')
ON CONFLICT ("name") DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_tournament_player_elo(_tournament_id uuid, _player_steam_id bigint)
RETURNS numeric
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    _tournament public.tournaments;
    _player public.players;
    _team_size int;
    _elo_type text;
BEGIN
    SELECT * INTO _tournament FROM public.tournaments t WHERE t.id = _tournament_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    SELECT * INTO _player FROM public.players p WHERE p.steam_id = _player_steam_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    _team_size := COALESCE(
        public.tournament_min_players_per_lineup(_tournament),
        public.tournament_max_players_per_lineup(_tournament)
    );
    _elo_type := CASE
        WHEN _team_size = 2 THEN 'Wingman'
        WHEN _team_size = 3 THEN 'Trios'
        ELSE 'Competitive'
    END;
    IF public.seasons_enabled() THEN
        RETURN public.get_player_season_elo_by_type(_player, _elo_type, public.get_active_season());
    END IF;
    RETURN public.get_player_elo_by_type(_player, _elo_type);
END;
$$;
