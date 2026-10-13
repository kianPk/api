CREATE TABLE IF NOT EXISTS public.battle_pass_seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer NOT NULL CHECK (number > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  premium_price_ypoints integer NOT NULL DEFAULT 600
    CHECK (premium_price_ypoints >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT battle_pass_seasons_number_key UNIQUE (number),
  CONSTRAINT battle_pass_seasons_range_check CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS public.battle_pass_progress (
  season_id uuid NOT NULL REFERENCES public.battle_pass_seasons (id)
    ON DELETE CASCADE,
  steam_id bigint NOT NULL REFERENCES public.players (steam_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  xp integer NOT NULL DEFAULT 0 CHECK (xp >= 0),
  premium boolean NOT NULL DEFAULT false,
  premium_purchased_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season_id, steam_id)
);

CREATE INDEX IF NOT EXISTS battle_pass_progress_xp_idx
  ON public.battle_pass_progress (season_id, xp DESC);

CREATE TABLE IF NOT EXISTS public.battle_pass_claims (
  season_id uuid NOT NULL REFERENCES public.battle_pass_seasons (id)
    ON DELETE CASCADE,
  steam_id bigint NOT NULL REFERENCES public.players (steam_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  level integer NOT NULL CHECK (level BETWEEN 1 AND 100),
  track text NOT NULL CHECK (track IN ('free', 'premium')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season_id, steam_id, level, track)
);

COMMENT ON TABLE public.battle_pass_seasons IS
  'Rolling Battle Pass seasons; the API opens the next one when the current ends';
COMMENT ON TABLE public.battle_pass_progress IS
  'Per-season XP snapshot and Premium track ownership';
COMMENT ON TABLE public.battle_pass_claims IS
  'Battle Pass level rewards a player has collected';
