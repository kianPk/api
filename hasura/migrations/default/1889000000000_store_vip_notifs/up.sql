-- Store purchase notifications + VIP roster for public servers

INSERT INTO public.e_notification_types ("value", "description") VALUES
  ('StorePurchasePaid', 'A store purchase was paid successfully'),
  ('StorePurchaseCancelled', 'A store purchase was cancelled or failed')
ON CONFLICT ("value") DO UPDATE
  SET "description" = EXCLUDED."description";

CREATE TABLE IF NOT EXISTS public.store_vip_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES public.servers (id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.store_orders (id) ON DELETE SET NULL,
  expires_at timestamptz,
  granted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_vip_grants_steam_server_key UNIQUE (steam_id, server_id)
);

CREATE INDEX IF NOT EXISTS store_vip_grants_server_active_idx
  ON public.store_vip_grants (server_id, expires_at);

COMMENT ON TABLE public.store_vip_grants IS
  'Active VIP roster from store purchases (per dedicated/public server)';
COMMENT ON COLUMN public.store_vip_grants.expires_at IS
  'NULL means permanent VIP';
