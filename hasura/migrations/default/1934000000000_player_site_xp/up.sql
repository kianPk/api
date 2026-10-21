CREATE TABLE IF NOT EXISTS public.player_site_xp (
  steam_id bigint PRIMARY KEY,
  xp integer NOT NULL DEFAULT 0 CHECK (xp >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
