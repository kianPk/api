DROP INDEX IF EXISTS public.store_products_vip_server_idx;
ALTER TABLE public.store_orders DROP COLUMN IF EXISTS vip_granted_at;
ALTER TABLE public.store_products DROP COLUMN IF EXISTS vip_duration;
ALTER TABLE public.store_products DROP COLUMN IF EXISTS vip_server_id;
