-- Restore the original GraphQL-only amount enforcement (breaks VIP shop carrier).
CREATE OR REPLACE FUNCTION public.store_orders_before_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  product_price integer;
BEGIN
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
