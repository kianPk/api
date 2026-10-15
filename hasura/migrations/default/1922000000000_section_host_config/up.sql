-- Section Host checkout: buyer-chosen slots, optional password + admin.

ALTER TABLE public.store_orders
  ADD COLUMN IF NOT EXISTS hosted_requested_slots integer,
  ADD COLUMN IF NOT EXISTS hosted_connect_password text,
  ADD COLUMN IF NOT EXISTS hosted_admin_steam_id bigint;

COMMENT ON COLUMN public.store_orders.hosted_requested_slots IS
  'Slot count the buyer chose for a section Host rental.';
COMMENT ON COLUMN public.store_orders.hosted_connect_password IS
  'Optional connect password applied when the Host server is provisioned.';
COMMENT ON COLUMN public.store_orders.hosted_admin_steam_id IS
  'Optional extra admin SteamID64 added after Host provision.';
