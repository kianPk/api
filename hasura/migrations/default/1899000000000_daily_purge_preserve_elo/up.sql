-- Allow finished matches to be purged for storage without wiping player ELO.
-- player_elo.match_id becomes nullable and survives match delete (SET NULL).

ALTER TABLE public.player_elo
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE public.player_elo
  DROP CONSTRAINT IF EXISTS player_elo_pkey;

ALTER TABLE public.player_elo
  ADD CONSTRAINT player_elo_pkey PRIMARY KEY (id);

-- Keep uniqueness for live (match-linked) rows.
CREATE UNIQUE INDEX IF NOT EXISTS player_elo_steam_match_type_uidx
  ON public.player_elo (steam_id, match_id, type)
  WHERE match_id IS NOT NULL;

ALTER TABLE public.player_elo
  ALTER COLUMN match_id DROP NOT NULL;

DO $$
DECLARE
  fk_name text;
BEGIN
  SELECT con.conname INTO fk_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'player_elo'
    AND con.contype = 'f'
    AND pg_get_constraintdef(con.oid) ILIKE '%match_id%references%matches%';

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.player_elo DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

ALTER TABLE public.player_elo
  ADD CONSTRAINT player_elo_match_id_fkey
  FOREIGN KEY (match_id)
  REFERENCES public.matches (id)
  ON UPDATE CASCADE
  ON DELETE SET NULL;

INSERT INTO public.settings (name, value) VALUES
  ('demo_purge_daily', 'true'),
  ('match_purge_daily', 'true'),
  ('match_purge_after_hours', '24')
ON CONFLICT (name) DO NOTHING;
