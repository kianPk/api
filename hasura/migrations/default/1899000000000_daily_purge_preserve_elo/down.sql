DELETE FROM public.settings
 WHERE name IN ('demo_purge_daily', 'match_purge_daily', 'match_purge_after_hours');

-- Rows with NULL match_id cannot be restored into the old NOT NULL PK.
DELETE FROM public.player_elo WHERE match_id IS NULL;

ALTER TABLE public.player_elo DROP CONSTRAINT IF EXISTS player_elo_match_id_fkey;

ALTER TABLE public.player_elo
  ALTER COLUMN match_id SET NOT NULL;

ALTER TABLE public.player_elo
  ADD CONSTRAINT player_elo_match_id_fkey
  FOREIGN KEY (match_id)
  REFERENCES public.matches (id)
  ON UPDATE CASCADE
  ON DELETE CASCADE;

DROP INDEX IF EXISTS public.player_elo_steam_match_type_uidx;

ALTER TABLE public.player_elo DROP CONSTRAINT IF EXISTS player_elo_pkey;

ALTER TABLE public.player_elo
  ADD CONSTRAINT player_elo_pkey PRIMARY KEY (steam_id, match_id, type);

ALTER TABLE public.player_elo DROP COLUMN IF EXISTS id;
