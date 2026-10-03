-- In-game admins and bans for a rented server. The owner manages both from the
-- panel; the YGuardAdmin plugin reads them with the server's api_password.

CREATE TABLE IF NOT EXISTS public.hosted_server_admins (
  hosted_server_id uuid NOT NULL REFERENCES public.hosted_servers (id) ON DELETE CASCADE,
  steam_id bigint NOT NULL,
  added_by bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hosted_server_id, steam_id)
);

CREATE TABLE IF NOT EXISTS public.hosted_server_bans (
  hosted_server_id uuid NOT NULL REFERENCES public.hosted_servers (id) ON DELETE CASCADE,
  steam_id bigint NOT NULL,
  name text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  banned_by bigint,
  banned_by_name text NOT NULL DEFAULT '',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hosted_server_id, steam_id)
);
