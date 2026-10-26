-- Club-owned shop: Club VIP + Public VIP builtins + up to 2 custom products.

CREATE TABLE IF NOT EXISTS public.club_shop_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('club_vip', 'public_vip', 'custom')),
  title text,
  description text,
  enabled boolean NOT NULL DEFAULT false,
  price_7d_irr bigint NOT NULL DEFAULT 0 CHECK (price_7d_irr >= 0),
  price_30d_irr bigint NOT NULL DEFAULT 0 CHECK (price_30d_irr >= 0),
  price_90d_irr bigint NOT NULL DEFAULT 0 CHECK (price_90d_irr >= 0),
  ypoint_enabled boolean NOT NULL DEFAULT false,
  price_7d_ypoint integer NOT NULL DEFAULT 0 CHECK (price_7d_ypoint >= 0),
  price_30d_ypoint integer NOT NULL DEFAULT 0 CHECK (price_30d_ypoint >= 0),
  price_90d_ypoint integer NOT NULL DEFAULT 0 CHECK (price_90d_ypoint >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT club_shop_products_custom_title_chk
    CHECK (kind <> 'custom' OR (title IS NOT NULL AND length(btrim(title)) > 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS club_shop_products_builtin_uq
  ON public.club_shop_products (club_id, kind)
  WHERE kind IN ('club_vip', 'public_vip');

CREATE INDEX IF NOT EXISTS club_shop_products_club_idx
  ON public.club_shop_products (club_id, sort_order, created_at);

-- Max 2 custom products per club.
CREATE OR REPLACE FUNCTION public.tbi_club_shop_products_custom_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  custom_count integer;
BEGIN
  IF NEW.kind = 'custom' THEN
    SELECT COUNT(*)::int INTO custom_count
      FROM public.club_shop_products
     WHERE club_id = NEW.club_id
       AND kind = 'custom'
       AND (TG_OP = 'INSERT' OR id IS DISTINCT FROM NEW.id);
    IF custom_count >= 2 THEN
      RAISE EXCEPTION 'club shop allows at most 2 custom products';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_club_shop_products_custom_limit ON public.club_shop_products;
CREATE TRIGGER tbi_club_shop_products_custom_limit
  BEFORE INSERT OR UPDATE ON public.club_shop_products
  FOR EACH ROW
  EXECUTE FUNCTION public.tbi_club_shop_products_custom_limit();

CREATE TABLE IF NOT EXISTS public.club_shop_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.club_shop_products(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('club_vip', 'public_vip', 'custom')),
  product_title text NOT NULL,
  buyer_steam_id bigint NOT NULL,
  duration text CHECK (duration IS NULL OR duration IN ('7d', '30d', '90d')),
  server_id uuid REFERENCES public.servers(id) ON DELETE SET NULL,
  amount_irr bigint NOT NULL DEFAULT 0,
  amount_ypoint integer NOT NULL DEFAULT 0,
  payment_method text NOT NULL CHECK (payment_method IN ('bale', 'ypoint')),
  store_order_id uuid REFERENCES public.store_orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'cancelled', 'failed')),
  fulfillment_status text NOT NULL DEFAULT 'none'
    CHECK (fulfillment_status IN ('none', 'pending', 'done')),
  fulfilled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE INDEX IF NOT EXISTS club_shop_orders_club_idx
  ON public.club_shop_orders (club_id, created_at DESC);

CREATE INDEX IF NOT EXISTS club_shop_orders_buyer_idx
  ON public.club_shop_orders (buyer_steam_id, created_at DESC);

CREATE INDEX IF NOT EXISTS club_shop_orders_store_order_idx
  ON public.club_shop_orders (store_order_id)
  WHERE store_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS club_shop_orders_fulfillment_idx
  ON public.club_shop_orders (club_id, fulfillment_status)
  WHERE fulfillment_status = 'pending';

ALTER TABLE public.store_orders
  DROP CONSTRAINT IF EXISTS store_orders_hosted_kind_check;

ALTER TABLE public.store_orders
  ADD CONSTRAINT store_orders_hosted_kind_check
    CHECK (
      hosted_kind IS NULL
      OR hosted_kind IN ('new', 'renew', 'slots', 'vip_shop', 'club_shop')
    );

INSERT INTO public.store_products
  (title, slug, description, price_irr, ypoint_amount, vip_server_id,
   vip_duration, hosted_slots, subscription_tier, sort_order, active)
VALUES (
  'Club shop (internal)',
  'club-shop',
  'Internal bill carrier for club shop sales. Not sold in the store.',
  0, NULL, NULL, NULL, NULL, NULL, 9998, false
)
ON CONFLICT (slug) DO UPDATE SET
  price_irr = 0,
  ypoint_amount = NULL,
  vip_server_id = NULL,
  vip_duration = NULL,
  hosted_slots = NULL,
  subscription_tier = NULL,
  active = false;

COMMENT ON TABLE public.club_shop_products IS
  'Per-club shop catalog: Club VIP, Public VIP, and up to 2 custom SKUs.';
COMMENT ON TABLE public.club_shop_orders IS
  'Club shop purchases; custom rows stay fulfillment=pending for staff.';
