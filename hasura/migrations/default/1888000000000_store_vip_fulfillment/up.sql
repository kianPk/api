-- Store VIP fulfillment: map products to a dedicated public server + duration.

ALTER TABLE public.store_products
  ADD COLUMN IF NOT EXISTS vip_server_id uuid
    REFERENCES public.servers (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vip_duration text;

COMMENT ON COLUMN public.store_products.vip_server_id IS
  'If set, paying credits timed VIP on this dedicated server via RCON css_addvip';
COMMENT ON COLUMN public.store_products.vip_duration IS
  'YGuardVIP duration token (e.g. 30d, 1mo). Required with vip_server_id.';

ALTER TABLE public.store_orders
  ADD COLUMN IF NOT EXISTS vip_granted_at timestamptz;

COMMENT ON COLUMN public.store_orders.vip_granted_at IS
  'When css_addvip was successfully sent for this paid order';

CREATE INDEX IF NOT EXISTS store_products_vip_server_idx
  ON public.store_products (vip_server_id)
  WHERE vip_server_id IS NOT NULL;
