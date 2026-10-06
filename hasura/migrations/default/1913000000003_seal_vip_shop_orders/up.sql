-- Hard seal: VIP shop orders must never be treated as hosted-server purchases,
-- even if an old API build still links them to a plan product with hosted_slots.
CREATE OR REPLACE FUNCTION public.tbiu_store_orders_seal_vip_shop()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.hosted_kind = 'vip_shop'
     OR (NEW.product_title IS NOT NULL AND NEW.product_title ~* '^VIP[[:space:]]+(7d|30d|90d)')
  THEN
    NEW.hosted_fulfilled_at := COALESCE(NEW.hosted_fulfilled_at, now());
    IF NEW.hosted_kind IS NULL OR NEW.hosted_kind NOT IN ('new', 'renew', 'slots') THEN
      NEW.hosted_kind := 'vip_shop';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_store_orders_seal_vip_shop ON public.store_orders;
CREATE TRIGGER tbiu_store_orders_seal_vip_shop
  BEFORE INSERT OR UPDATE ON public.store_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.tbiu_store_orders_seal_vip_shop();

UPDATE public.store_orders
SET hosted_fulfilled_at = COALESCE(hosted_fulfilled_at, now()),
    hosted_kind = 'vip_shop'
WHERE hosted_fulfilled_at IS NULL
  AND status IN ('pending', 'paid')
  AND (
    hosted_kind = 'vip_shop'
    OR COALESCE(product_title, '') ~* '^VIP[[:space:]]+(7d|30d|90d)'
  );

INSERT INTO public.store_products
  (title, slug, description, price_irr, ypoint_amount, vip_server_id,
   vip_duration, hosted_slots, subscription_tier, sort_order, active)
VALUES (
  'Hosted VIP (internal)',
  'hosted-vip-shop',
  'Internal bill carrier for hosted server VIP sales. Not sold in the store.',
  0, NULL, NULL, NULL, NULL, NULL, 9999, false
)
ON CONFLICT (slug) DO UPDATE SET
  price_irr = 0,
  ypoint_amount = NULL,
  vip_server_id = NULL,
  vip_duration = NULL,
  hosted_slots = NULL,
  subscription_tier = NULL,
  active = false;

ALTER TABLE public.store_orders
  DROP CONSTRAINT IF EXISTS store_orders_hosted_kind_check;

ALTER TABLE public.store_orders
  ADD CONSTRAINT store_orders_hosted_kind_check
    CHECK (hosted_kind IS NULL OR hosted_kind IN ('new', 'renew', 'slots', 'vip_shop'));
