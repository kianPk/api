CREATE TABLE IF NOT EXISTS public.store_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_irr integer NOT NULL CHECK (price_irr >= 0),
  image_url text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_products_slug_key UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS store_products_active_sort_idx
  ON public.store_products (active, sort_order ASC, created_at DESC);

CREATE TABLE IF NOT EXISTS public.store_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.store_products (id) ON DELETE RESTRICT,
  buyer_steam_id text NOT NULL REFERENCES public.players (steam_id) ON DELETE CASCADE,
  amount_irr integer NOT NULL CHECK (amount_irr >= 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  bale_payload text NOT NULL,
  bale_payment_charge_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  CONSTRAINT store_orders_bale_payload_key UNIQUE (bale_payload)
);

CREATE INDEX IF NOT EXISTS store_orders_buyer_idx
  ON public.store_orders (buyer_steam_id, created_at DESC);

CREATE INDEX IF NOT EXISTS store_orders_status_idx
  ON public.store_orders (status);

COMMENT ON TABLE public.store_products IS 'Catalog products sold via the panel Store';
COMMENT ON TABLE public.store_orders IS 'Store checkout orders paid through Bale Pay';
COMMENT ON COLUMN public.store_products.price_irr IS 'Price in Iranian Rials (Bale invoice amount unit)';
COMMENT ON COLUMN public.store_orders.bale_payload IS 'Opaque payload echoed by Bale invoice / successful_payment';
