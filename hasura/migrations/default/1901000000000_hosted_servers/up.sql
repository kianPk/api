-- Hosted (rented) game servers: bought from the Store, auto-provisioned as a
-- dedicated server on a game node, owned by the buyer until expires_at.

ALTER TABLE public.servers
  ADD COLUMN IF NOT EXISTS steam_account_token text;

COMMENT ON COLUMN public.servers.steam_account_token IS
  'GSLT passed as +sv_setsteamaccount to dedicated server pods';

ALTER TABLE public.store_products
  ADD COLUMN IF NOT EXISTS hosted_slots integer
    CHECK (hosted_slots IS NULL OR (hosted_slots BETWEEN 2 AND 64));

COMMENT ON COLUMN public.store_products.hosted_slots IS
  'If set, the product is a hosted server plan with this many slots; vip_duration is the rental period';

CREATE TABLE IF NOT EXISTS public.hosted_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid REFERENCES public.servers (id) ON DELETE SET NULL,
  pending_server_id uuid,
  owner_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  product_id uuid REFERENCES public.store_products (id) ON DELETE SET NULL,
  slots integer NOT NULL,
  label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'active', 'expired', 'suspended', 'failed', 'deleted')),
  status_detail text,
  expires_at timestamptz NOT NULL,
  gslt_steam_id text,
  reminded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS hosted_servers_server_key
  ON public.hosted_servers (server_id)
  WHERE server_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS hosted_servers_owner_idx
  ON public.hosted_servers (owner_steam_id, created_at DESC);

CREATE INDEX IF NOT EXISTS hosted_servers_status_expiry_idx
  ON public.hosted_servers (status, expires_at);

COMMENT ON TABLE public.hosted_servers IS
  'Game servers rented through the Store';
COMMENT ON COLUMN public.hosted_servers.pending_server_id IS
  'Server id reserved before the servers row exists, so the deployment built from its insert event already knows it is hosted';
COMMENT ON COLUMN public.hosted_servers.gslt_steam_id IS
  'Steam id of an auto-created GSLT, so it can be deleted when the server is removed';

ALTER TABLE public.store_orders
  ADD COLUMN IF NOT EXISTS hosted_kind text
    CHECK (hosted_kind IS NULL OR hosted_kind IN ('new', 'renew')),
  ADD COLUMN IF NOT EXISTS hosted_server_id uuid
    REFERENCES public.hosted_servers (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS hosted_type text,
  ADD COLUMN IF NOT EXISTS hosted_label text,
  ADD COLUMN IF NOT EXISTS hosted_fulfilled_at timestamptz;

CREATE INDEX IF NOT EXISTS store_orders_hosted_unfulfilled_idx
  ON public.store_orders (paid_at)
  WHERE hosted_kind IS NOT NULL AND hosted_fulfilled_at IS NULL;

INSERT INTO public.settings ("name", "value") VALUES
  ('hosted_servers.enabled', 'true'),
  ('hosted_servers.node_id', 'b039e0b7-8505-4fe8-a811-425a00d8503a'),
  ('hosted_servers.max_active', '3'),
  ('hosted_servers.reserve_match_slots', '2'),
  ('hosted_servers.grace_days', '3')
ON CONFLICT ("name") DO NOTHING;
