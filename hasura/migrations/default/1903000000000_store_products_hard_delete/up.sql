-- Products can be deleted outright; orders keep their own title snapshot and
-- the product link becomes NULL.

ALTER TABLE public.store_orders
  ADD COLUMN IF NOT EXISTS product_title text;

UPDATE public.store_orders o
SET product_title = p.title
FROM public.store_products p
WHERE p.id = o.product_id AND o.product_title IS NULL;

DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.store_orders'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.store_products'::regclass
      AND a.attname = 'product_id'
  LOOP
    EXECUTE format('ALTER TABLE public.store_orders DROP CONSTRAINT %I', fk.conname);
  END LOOP;
END $$;

ALTER TABLE public.store_orders ALTER COLUMN product_id DROP NOT NULL;

ALTER TABLE public.store_orders
  ADD CONSTRAINT store_orders_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES public.store_products (id) ON DELETE SET NULL;
