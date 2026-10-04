-- Global casual/public ladder. Not matchmaking ELO — points from public servers.
CREATE TABLE IF NOT EXISTS public.public_server_ranks (
  steam_id bigint PRIMARY KEY,
  name text,
  points integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  kills integer NOT NULL DEFAULT 0 CHECK (kills >= 0),
  deaths integer NOT NULL DEFAULT 0 CHECK (deaths >= 0),
  assists integer NOT NULL DEFAULT 0 CHECK (assists >= 0),
  headshots integer NOT NULL DEFAULT 0 CHECK (headshots >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS public_server_ranks_points_idx
  ON public.public_server_ranks (points DESC, updated_at DESC);

COMMENT ON TABLE public.public_server_ranks IS
  'YGuardRanks: public-server points and Competitive skill-group ladder';
