-- Owner-priced VIP packages sold for Ypoints on hosted public servers.
ALTER TABLE public.hosted_servers
  ADD COLUMN IF NOT EXISTS vip_sale_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vip_price_7d integer NOT NULL DEFAULT 0
    CHECK (vip_price_7d >= 0),
  ADD COLUMN IF NOT EXISTS vip_price_30d integer NOT NULL DEFAULT 0
    CHECK (vip_price_30d >= 0),
  ADD COLUMN IF NOT EXISTS vip_price_90d integer NOT NULL DEFAULT 0
    CHECK (vip_price_90d >= 0);

COMMENT ON COLUMN public.hosted_servers.vip_sale_enabled IS
  'When true, players can buy VIP for this hosted server from the public server page';
COMMENT ON COLUMN public.hosted_servers.vip_price_7d IS
  'Ypoint price for 7-day VIP (0 = not offered)';
COMMENT ON COLUMN public.hosted_servers.vip_price_30d IS
  'Ypoint price for 30-day VIP (0 = not offered)';
COMMENT ON COLUMN public.hosted_servers.vip_price_90d IS
  'Ypoint price for 90-day VIP (0 = not offered)';
