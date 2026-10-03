-- Slots bought on top of a rented server's plan. slots stays the total the
-- server runs with; slots - extra_slots is what the plan itself provides.
ALTER TABLE public.hosted_servers
  ADD COLUMN IF NOT EXISTS extra_slots integer NOT NULL DEFAULT 0
    CHECK (extra_slots >= 0);

ALTER TABLE public.store_orders
  ADD COLUMN IF NOT EXISTS hosted_extra_slots integer
    CHECK (hosted_extra_slots IS NULL OR hosted_extra_slots > 0);

ALTER TABLE public.store_orders
  DROP CONSTRAINT IF EXISTS store_orders_hosted_kind_check;

ALTER TABLE public.store_orders
  ADD CONSTRAINT store_orders_hosted_kind_check
    CHECK (hosted_kind IS NULL OR hosted_kind IN ('new', 'renew', 'slots'));
