ALTER TABLE public.hosted_servers
  DROP COLUMN IF EXISTS vip_price_90d,
  DROP COLUMN IF EXISTS vip_price_30d,
  DROP COLUMN IF EXISTS vip_price_7d,
  DROP COLUMN IF EXISTS vip_sale_enabled;
