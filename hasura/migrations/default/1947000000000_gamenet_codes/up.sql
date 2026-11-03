-- Gaming-net device codes: staff enter a code once on each cafe PC in the
-- launcher; anyone who plays from that bound device gets site XP ×2 while
-- their session is active.

CREATE TABLE IF NOT EXISTS public.gamenet_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  label text NOT NULL,
  note text NOT NULL DEFAULT '',
  club_id uuid REFERENCES public.clubs (id) ON DELETE SET NULL,
  max_devices integer NOT NULL DEFAULT 50
    CHECK (max_devices >= 1 AND max_devices <= 500),
  created_by_steam_id bigint REFERENCES public.players (steam_id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS gamenet_codes_code_uidx
  ON public.gamenet_codes (upper(code));
CREATE INDEX IF NOT EXISTS gamenet_codes_club_idx
  ON public.gamenet_codes (club_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS gamenet_codes_active_idx
  ON public.gamenet_codes (created_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.gamenet_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id uuid NOT NULL REFERENCES public.gamenet_codes (id) ON DELETE CASCADE,
  device_id text NOT NULL,
  device_label text NOT NULL DEFAULT '',
  bound_by_steam_id bigint REFERENCES public.players (steam_id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  bound_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT gamenet_devices_device_id_len
    CHECK (char_length(device_id) BETWEEN 8 AND 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS gamenet_devices_active_device_uidx
  ON public.gamenet_devices (device_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS gamenet_devices_code_idx
  ON public.gamenet_devices (code_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.gamenet_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_row_id uuid NOT NULL REFERENCES public.gamenet_devices (id)
    ON DELETE CASCADE,
  steam_id bigint NOT NULL REFERENCES public.players (steam_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  club_id uuid REFERENCES public.clubs (id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gamenet_sessions_active_steam_idx
  ON public.gamenet_sessions (steam_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS gamenet_sessions_device_idx
  ON public.gamenet_sessions (device_row_id);
