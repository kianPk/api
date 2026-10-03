-- Orders outlive their product, so they carry the title they were bought under.
CREATE OR REPLACE FUNCTION public.tbi_store_orders_product_title() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_title IS NULL AND NEW.product_id IS NOT NULL THEN
    SELECT title INTO NEW.product_title
    FROM public.store_products
    WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tbi_store_orders_product_title ON public.store_orders;
CREATE TRIGGER tbi_store_orders_product_title
  BEFORE INSERT ON public.store_orders
  FOR EACH ROW EXECUTE FUNCTION public.tbi_store_orders_product_title();
