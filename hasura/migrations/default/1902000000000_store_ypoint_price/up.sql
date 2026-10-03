ALTER TABLE public.store_products
  ADD COLUMN IF NOT EXISTS price_ypoint integer
    CHECK (price_ypoint IS NULL OR price_ypoint > 0);

COMMENT ON COLUMN public.store_products.price_ypoint IS
  'If set, the product can also be bought with this many Ypoints';

ALTER TABLE public.store_orders
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'bale'
    CHECK (payment_method IN ('bale', 'ypoint')),
  ADD COLUMN IF NOT EXISTS amount_ypoint integer;
