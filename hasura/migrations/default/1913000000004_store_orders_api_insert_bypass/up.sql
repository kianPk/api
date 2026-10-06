-- GraphQL buyers insert single-product orders without cart_items/hosted_kind;
-- those paths still force amount_irr from an active catalog product.
-- Nest API checkouts (cart, hosting, VIP shop) set cart_items and/or hosted_kind
-- and must keep their computed amount (VIP shop uses an inactive carrier product).
CREATE OR REPLACE FUNCTION public.store_orders_before_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  product_price integer;
BEGIN
  IF NEW.cart_items IS NOT NULL OR NEW.hosted_kind IS NOT NULL THEN
    IF NEW.product_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.store_products WHERE id = NEW.product_id
    ) THEN
      RAISE EXCEPTION 'store product not found or inactive';
    END IF;

    NEW.status := 'pending';
    IF NEW.id IS NULL THEN
      NEW.id := gen_random_uuid();
    END IF;
    IF NEW.bale_payload IS NULL OR NEW.bale_payload = '' THEN
      NEW.bale_payload := 'store:' || NEW.id::text;
    END IF;
    NEW.paid_at := NULL;
    NEW.bale_payment_charge_id := NULL;
    RETURN NEW;
  END IF;

  SELECT price_irr INTO product_price
  FROM public.store_products
  WHERE id = NEW.product_id AND active = true;

  IF product_price IS NULL THEN
    RAISE EXCEPTION 'store product not found or inactive';
  END IF;

  NEW.amount_irr := product_price;
  NEW.status := 'pending';
  IF NEW.id IS NULL THEN
    NEW.id := gen_random_uuid();
  END IF;
  IF NEW.bale_payload IS NULL OR NEW.bale_payload = '' THEN
    NEW.bale_payload := 'store:' || NEW.id::text;
  END IF;
  NEW.paid_at := NULL;
  NEW.bale_payment_charge_id := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS store_orders_before_insert ON public.store_orders;
CREATE TRIGGER store_orders_before_insert
  BEFORE INSERT ON public.store_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.store_orders_before_insert();
