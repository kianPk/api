ALTER TABLE public.store_orders
  DROP COLUMN IF EXISTS hosted_requested_slots,
  DROP COLUMN IF EXISTS hosted_connect_password,
  DROP COLUMN IF EXISTS hosted_admin_steam_id;
