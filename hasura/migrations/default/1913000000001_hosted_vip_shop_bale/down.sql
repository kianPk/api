ALTER TABLE public.store_orders
  DROP CONSTRAINT IF EXISTS store_orders_hosted_kind_check;

DELETE FROM public.store_orders WHERE hosted_kind = 'vip_shop' AND status = 'pending';
UPDATE public.store_orders SET hosted_kind = NULL WHERE hosted_kind = 'vip_shop';

ALTER TABLE public.store_orders
  ADD CONSTRAINT store_orders_hosted_kind_check
    CHECK (hosted_kind IS NULL OR hosted_kind IN ('new', 'renew', 'slots'));
