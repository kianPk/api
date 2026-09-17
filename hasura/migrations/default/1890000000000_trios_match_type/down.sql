DELETE FROM public.settings WHERE name = 'public.matchmaking_trios';

DELETE FROM public._map_pool
WHERE map_pool_id IN (
  SELECT id FROM public.map_pools WHERE type = 'Trios'
);

DELETE FROM public.map_pools WHERE type = 'Trios';
DELETE FROM public.maps WHERE type = 'Trios';
DELETE FROM public.e_map_pool_types WHERE value = 'Trios';
DELETE FROM public.e_game_cfg_types WHERE value = 'Trios';
DELETE FROM public.e_match_types WHERE value = 'Trios';
