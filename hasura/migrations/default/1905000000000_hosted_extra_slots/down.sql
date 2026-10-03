ALTER TABLE public.store_orders
  DROP CONSTRAINT IF EXISTS store_orders_hosted_kind_check;

DELETE FROM public.store_orders WHERE hosted_kind = 'slots' AND status = 'pending';

UPDATE public.store_orders SET hosted_kind = NULL WHERE hosted_kind = 'slots';

ALTER TABLE public.store_orders
  ADD CONSTRAINT store_orders_hosted_kind_check
    CHECK (hosted_kind IS NULL OR hosted_kind IN ('new', 'renew'));

ALTER TABLE public.store_orders DROP COLUMN IF EXISTS hosted_extra_slots;

ALTER TABLE public.hosted_servers DROP COLUMN IF EXISTS extra_slots;
