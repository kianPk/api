-- A pending order whose product is gone could no longer be invoiced or fulfilled.
CREATE OR REPLACE FUNCTION public.tbd_store_products_cancel_pending() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.store_orders
  SET status = 'cancelled'
  WHERE product_id = OLD.id AND status = 'pending';
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS tbd_store_products_cancel_pending ON public.store_products;
CREATE TRIGGER tbd_store_products_cancel_pending
  BEFORE DELETE ON public.store_products
  FOR EACH ROW EXECUTE FUNCTION public.tbd_store_products_cancel_pending();
