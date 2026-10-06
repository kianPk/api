-- Convert custom Trios (3v3 Competitive-style) to Valve Rush parity.

-- 1) Enums
INSERT INTO public.e_match_types ("value", "description") VALUES
  ('Rush', 'Fast-paced 3 vs 3 matches, pushing room by room')
ON CONFLICT ("value") DO UPDATE
  SET "description" = EXCLUDED."description";

INSERT INTO public.e_game_cfg_types ("value", "description") VALUES
  ('Rush', 'Rush game configuration')
ON CONFLICT ("value") DO UPDATE
  SET "description" = EXCLUDED."description";

INSERT INTO public.e_map_pool_types ("value", "description") VALUES
  ('Rush', '3 vs 3')
ON CONFLICT ("value") DO UPDATE
  SET "description" = EXCLUDED."description";

-- 2) rush_001 map + seed pool
INSERT INTO public.maps (
  "name", "type", "active_pool", "workshop_map_id", "poster", "patch", "label", "enabled"
) VALUES (
  'rush_001',
  'Rush',
  true,
  null,
  '/img/maps/screenshots/rush_001.webp',
  '/img/maps/icons/rush_001.svg',
  null,
  true
)
ON CONFLICT ("name", "type") DO UPDATE SET
  "active_pool" = true,
  "poster" = EXCLUDED."poster",
  "patch" = EXCLUDED."patch",
  "enabled" = true,
  "deleted_at" = NULL;

INSERT INTO public.map_pools ("type", "enabled", "seed")
SELECT 'Rush', true, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.map_pools
  WHERE type = 'Rush' AND seed = true AND enabled = true
);

-- Clear and seed Rush pool with rush_001 only
DELETE FROM public._map_pool
WHERE map_pool_id IN (
  SELECT id FROM public.map_pools WHERE type = 'Rush' AND enabled = true
);

INSERT INTO public._map_pool (map_id, map_pool_id)
SELECT m.id, p.id
FROM public.maps m
JOIN public.map_pools p
  ON p.type = 'Rush' AND p.seed = true AND p.enabled = true
WHERE m.type = 'Rush'
  AND m.name = 'rush_001'
  AND m.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- 3) Repoint live FKs from Trios → Rush before dropping Trios enums
UPDATE public.match_options
SET type = 'Rush',
    best_of = 1,
    mr = 8,
    overtime = false,
    knife_round = false,
    map_veto = false,
    map_pool_id = COALESCE(
      (SELECT id FROM public.map_pools WHERE type = 'Rush' AND enabled = true ORDER BY seed DESC LIMIT 1),
      map_pool_id
    )
WHERE type = 'Trios';

UPDATE public.player_elo
SET type = 'Rush'
WHERE type = 'Trios';

UPDATE public.match_type_cfgs
SET type = 'Rush'
WHERE type = 'Trios';

UPDATE public.draft_games
SET type = 'Rush',
    capacity = 6
WHERE type = 'Trios';

-- Soft-delete Competitive clones that were Trios maps; disable old Trios pools
UPDATE public.maps
SET deleted_at = COALESCE(deleted_at, now()),
    enabled = false,
    active_pool = false
WHERE type = 'Trios';

DELETE FROM public._map_pool
WHERE map_pool_id IN (SELECT id FROM public.map_pools WHERE type = 'Trios');

UPDATE public.map_pools
SET enabled = false
WHERE type = 'Trios';

-- 4) Settings rename (preserve values)
INSERT INTO public.settings ("name", "value")
SELECT 'public.matchmaking_rush', value
FROM public.settings
WHERE name = 'public.matchmaking_trios'
ON CONFLICT ("name") DO UPDATE SET value = EXCLUDED.value;

INSERT INTO public.settings ("name", "value")
VALUES ('public.matchmaking_rush', 'true')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO public.settings ("name", "value")
SELECT 'public.ypoint_cost_rush', value
FROM public.settings
WHERE name = 'public.ypoint_cost_trios'
ON CONFLICT ("name") DO UPDATE SET value = EXCLUDED.value;

INSERT INTO public.settings ("name", "value")
VALUES ('public.ypoint_cost_rush', '12')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO public.settings ("name", "value")
SELECT 'public.ypoint_free_rush', value
FROM public.settings
WHERE name = 'public.ypoint_free_trios'
ON CONFLICT ("name") DO UPDATE SET value = EXCLUDED.value;

INSERT INTO public.settings ("name", "value")
VALUES ('public.ypoint_free_rush', 'false')
ON CONFLICT ("name") DO NOTHING;

DELETE FROM public.settings
WHERE name IN (
  'public.matchmaking_trios',
  'public.ypoint_cost_trios',
  'public.ypoint_free_trios'
);

-- 5) Functions
CREATE OR REPLACE FUNCTION public.get_match_type_min_players(match_type TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    IF match_type = 'Competitive' OR match_type = 'Premier' OR match_type = 'Faceit' THEN
        RETURN 5;
    ELSIF match_type = 'Rush' THEN
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
            'rush', get_player_elo_by_type(player, 'Rush'),
            'wingman', get_player_elo_by_type(player, 'Wingman'),
            'duel', get_player_elo_by_type(player, 'Duel')
        );
    END IF;

    _active_season_id := get_active_season();

    return jsonb_build_object(
        'competitive', get_player_season_elo_by_type(player, 'Competitive', _active_season_id),
        'rush', get_player_season_elo_by_type(player, 'Rush', _active_season_id),
        'wingman', get_player_season_elo_by_type(player, 'Wingman', _active_season_id),
        'duel', get_player_season_elo_by_type(player, 'Duel', _active_season_id),
        'tournament_competitive', get_player_tournament_elo_by_type(player, 'Competitive'),
        'tournament_rush', get_player_tournament_elo_by_type(player, 'Rush'),
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
        'rush', get_player_peak_elo_by_type(player, 'Rush'),
        'wingman', get_player_peak_elo_by_type(player, 'Wingman'),
        'duel', get_player_peak_elo_by_type(player, 'Duel')
    );
END;
$$;

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
        WHEN _team_size = 3 THEN 'Rush'
        ELSE 'Competitive'
    END;
    IF public.seasons_enabled() THEN
        RETURN public.get_player_season_elo_by_type(_player, _elo_type, public.get_active_season());
    END IF;
    RETURN public.get_player_elo_by_type(_player, _elo_type);
END;
$$;

CREATE OR REPLACE FUNCTION public.can_cancel_match(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    _match_type text;
BEGIN
    IF match.status IN ('Finished', 'Tie', 'Canceled', 'Forfeit', 'Surrendered') THEN
        RETURN false;
    END IF;

    SELECT mo.type::text
      INTO _match_type
      FROM match_options mo
      WHERE mo.id = match.match_options_id;

    IF _match_type IN ('Competitive', 'Wingman', 'Rush', 'Duel', 'Premier') THEN
        RETURN hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator');
    END IF;

    IF NOT is_match_organizer(match, hasura_session) THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_total_player_wins_rush(player public.players) RETURNS INT
    LANGUAGE sql STABLE
    AS $$ SELECT public.get_total_player_wins_by_type(player, 'Rush'); $$;

CREATE OR REPLACE FUNCTION public.get_total_player_losses_rush(player public.players) RETURNS INT
    LANGUAGE sql STABLE
    AS $$ SELECT public.get_total_player_losses_by_type(player, 'Rush'); $$;

-- 6) Force Rush match options on insert/update
CREATE OR REPLACE FUNCTION public.tbi_match_options() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
lan_count int;
region_count int;
BEGIN
    SELECT COUNT(DISTINCT region) INTO region_count
        FROM servers where enabled = true and type = 'Ranked';

    IF NEW.regions IS NOT NULL THEN
        SELECT count(*) INTO lan_count
        FROM server_regions
        WHERE value = ANY(NEW.regions) AND is_lan = true;

        IF lan_count > 0 THEN
            IF (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-role')::text = 'user' THEN
                RAISE EXCEPTION 'Cannot assign the Lan region' USING ERRCODE = '22000';
            END IF;
        END IF;
    END IF;

    IF region_count = 1 THEN
        NEW.region_veto = false;
        NEW.regions = (SELECT array_agg(region) FROM servers where enabled = true);
    END IF;

    IF NEW.type = 'Rush' THEN
        NEW.best_of := 1;
        NEW.mr := 8;
        NEW.overtime := false;
        NEW.knife_round := false;
        NEW.map_veto := false;
    END IF;

    PERFORM assert_game_mode_selectable(NEW.game_mode_id);

	RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbu_match_options() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match_status text;
BEGIN
    SELECT m.status INTO _match_status
        FROM matches m
        INNER JOIN match_options mo ON mo.id = m.match_options_id
        WHERE mo.id = OLD.id
        LIMIT 1;

    IF _match_status = 'Finished' OR _match_status = 'Forfeit' OR _match_status = 'Tie' OR _match_status = 'Surrendered' THEN
        RAISE EXCEPTION 'Cannot change match options after match is finished' USING ERRCODE = '22000';
    END IF;

    IF _match_status != 'PickingPlayers' THEN
      IF (NEW.invite_code IS DISTINCT FROM OLD.invite_code) THEN
        RAISE EXCEPTION 'Cannot modify invite code' USING ERRCODE = '22000';
      END IF;
    END IF;

    IF _match_status = 'Live' OR _match_status = 'Veto' THEN
        NEW.regions = OLD.regions;

        IF (NEW.best_of IS DISTINCT FROM OLD.best_of) THEN
            RAISE EXCEPTION 'Cannot modify best of during Live/Veto' USING ERRCODE = '22000';
        END IF;
        IF (NEW.map_veto IS DISTINCT FROM OLD.map_veto) THEN
            RAISE EXCEPTION 'Cannot modify map veto during Live/Veto' USING ERRCODE = '22000';
        END IF;
        IF (NEW.map_pool_id IS DISTINCT FROM OLD.map_pool_id) THEN
            RAISE EXCEPTION 'Cannot modify map pool during Live/Veto' USING ERRCODE = '22000';
        END IF;
        IF (NEW.type IS DISTINCT FROM OLD.type) THEN
            RAISE EXCEPTION 'Cannot modify match type during Live/Veto' USING ERRCODE = '22000';
        END IF;
        IF (NEW.region_veto IS DISTINCT FROM OLD.region_veto) THEN
            RAISE EXCEPTION 'Cannot modify region veto during Live/Veto' USING ERRCODE = '22000';
        END IF;
        IF (NEW.prefer_dedicated_server IS DISTINCT FROM OLD.prefer_dedicated_server) THEN
            RAISE EXCEPTION 'Cannot modify prefer dedicated server during Live/Veto' USING ERRCODE = '22000';
        END IF;
        IF (NEW.mr IS DISTINCT FROM OLD.mr AND _match_status = 'Live') THEN
            RAISE EXCEPTION 'Cannot modify mr during Live' USING ERRCODE = '22000';
        END IF;
        IF (NEW.game_mode_id IS DISTINCT FROM OLD.game_mode_id) THEN
            RAISE EXCEPTION 'Cannot modify game mode during Live/Veto' USING ERRCODE = '22000';
        END IF;
    END IF;

    IF NEW.type = 'Rush' THEN
        NEW.best_of := 1;
        NEW.mr := 8;
        NEW.overtime := false;
        NEW.knife_round := false;
        NEW.map_veto := false;
    END IF;

    IF (NEW.game_mode_id IS DISTINCT FROM OLD.game_mode_id) THEN
        PERFORM assert_game_mode_selectable(NEW.game_mode_id);
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbi_draft_games() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT has_available_server_region() THEN
        RAISE EXCEPTION 'No game server regions are currently available' USING ERRCODE = '22000';
    END IF;

    NEW.capacity := CASE NEW.type
        WHEN 'Duel' THEN 2
        WHEN 'Wingman' THEN 4
        WHEN 'Rush' THEN 6
        ELSE 10
    END;

    IF NEW.mode = 'Teams' AND NEW.team_1_id IS NOT NULL AND NEW.team_2_id IS NOT NULL THEN
        NEW.access := 'Private';
    END IF;

    NEW.expires_at := now() + interval '30 minutes';

    RETURN NEW;
END;
$$;

-- 7) Retire Trios pools. Keep soft-deleted Trios map rows + enum values so
-- historical match_maps FKs stay valid; they are unused for new matches.
DELETE FROM public.map_pools WHERE type = 'Trios' AND id NOT IN (
  SELECT DISTINCT map_pool_id FROM public.match_options WHERE map_pool_id IS NOT NULL
);
UPDATE public.map_pools SET enabled = false, seed = false WHERE type = 'Trios';
UPDATE public.e_match_types
SET description = 'Retired — use Rush'
WHERE value = 'Trios';
