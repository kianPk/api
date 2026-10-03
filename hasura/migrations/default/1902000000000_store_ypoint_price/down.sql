ALTER TABLE public.store_orders
  DROP COLUMN IF EXISTS amount_ypoint,
  DROP COLUMN IF EXISTS payment_method;

ALTER TABLE public.store_products DROP COLUMN IF EXISTS price_ypoint;
