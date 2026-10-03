ALTER TABLE public.store_orders DROP CONSTRAINT IF EXISTS store_orders_product_id_fkey;

DELETE FROM public.store_orders WHERE product_id IS NULL;

ALTER TABLE public.store_orders ALTER COLUMN product_id SET NOT NULL;

ALTER TABLE public.store_orders
  ADD CONSTRAINT store_orders_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES public.store_products (id) ON DELETE RESTRICT;

ALTER TABLE public.store_orders DROP COLUMN IF EXISTS product_title;
