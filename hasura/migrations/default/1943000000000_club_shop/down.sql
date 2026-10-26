DROP TRIGGER IF EXISTS tbi_club_shop_products_custom_limit ON public.club_shop_products;
DROP FUNCTION IF EXISTS public.tbi_club_shop_products_custom_limit();

DROP TABLE IF EXISTS public.club_shop_orders;
DROP TABLE IF EXISTS public.club_shop_products;

ALTER TABLE public.store_orders
  DROP CONSTRAINT IF EXISTS store_orders_hosted_kind_check;

ALTER TABLE public.store_orders
  ADD CONSTRAINT store_orders_hosted_kind_check
    CHECK (hosted_kind IS NULL OR hosted_kind IN ('new', 'renew', 'slots', 'vip_shop'));

DELETE FROM public.store_products WHERE slug = 'club-shop';
