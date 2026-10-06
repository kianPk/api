-- Reverse Rush → Trios (best-effort; does not restore Competitive Trios map clones)

INSERT INTO public.e_match_types ("value", "description") VALUES
  ('Trios', 'Ranked 3 vs 3 competitive matches with full team coordination')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";

INSERT INTO public.e_game_cfg_types ("value", "description") VALUES
  ('Trios', 'Trios (3v3) game configuration')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";

INSERT INTO public.e_map_pool_types ("value", "description") VALUES
  ('Trios', '3 vs 3')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";

UPDATE public.match_options SET type = 'Trios' WHERE type = 'Rush';
UPDATE public.player_elo SET type = 'Trios' WHERE type = 'Rush';
UPDATE public.match_type_cfgs SET type = 'Trios' WHERE type = 'Rush';
UPDATE public.draft_games SET type = 'Trios' WHERE type = 'Rush';

INSERT INTO public.settings ("name", "value")
SELECT 'public.matchmaking_trios', value FROM public.settings WHERE name = 'public.matchmaking_rush'
ON CONFLICT ("name") DO UPDATE SET value = EXCLUDED.value;
INSERT INTO public.settings ("name", "value")
SELECT 'public.ypoint_cost_trios', value FROM public.settings WHERE name = 'public.ypoint_cost_rush'
ON CONFLICT ("name") DO UPDATE SET value = EXCLUDED.value;
INSERT INTO public.settings ("name", "value")
SELECT 'public.ypoint_free_trios', value FROM public.settings WHERE name = 'public.ypoint_free_rush'
ON CONFLICT ("name") DO UPDATE SET value = EXCLUDED.value;

DELETE FROM public.settings
WHERE name IN ('public.matchmaking_rush', 'public.ypoint_cost_rush', 'public.ypoint_free_rush');

DELETE FROM public.e_map_pool_types WHERE value = 'Rush';
DELETE FROM public.e_game_cfg_types WHERE value = 'Rush';
DELETE FROM public.e_match_types WHERE value = 'Rush';
