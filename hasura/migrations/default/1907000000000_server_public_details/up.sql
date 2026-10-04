-- What visitors see on the public-servers "Server details" dialog.
CREATE TABLE IF NOT EXISTS public.server_public_profile (
  server_id uuid PRIMARY KEY REFERENCES public.servers (id) ON DELETE CASCADE,
  show_vips boolean NOT NULL DEFAULT true,
  show_ranks boolean NOT NULL DEFAULT true,
  show_bans boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Bans mirrored from game servers (YGuardAdmin) for public dedicated boxes.
CREATE TABLE IF NOT EXISTS public.server_bans (
  server_id uuid NOT NULL REFERENCES public.servers (id) ON DELETE CASCADE,
  steam_id bigint NOT NULL,
  name text,
  reason text,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, steam_id)
);

CREATE INDEX IF NOT EXISTS server_bans_server_active_idx
  ON public.server_bans (server_id, expires_at);

-- Per-server view of the public ladder (who earned points on this box).
CREATE TABLE IF NOT EXISTS public.public_server_rank_presence (
  server_id uuid NOT NULL REFERENCES public.servers (id) ON DELETE CASCADE,
  steam_id bigint NOT NULL,
  name text,
  points integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, steam_id)
);

CREATE INDEX IF NOT EXISTS public_server_rank_presence_points_idx
  ON public.public_server_rank_presence (server_id, points DESC, updated_at ASC);
