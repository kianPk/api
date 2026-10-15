-- Servers → Host: user picks mode + duration; price is calculated from hourly rates.

ALTER TABLE public.store_orders
  ADD COLUMN IF NOT EXISTS hosted_duration text;

COMMENT ON COLUMN public.store_orders.hosted_duration IS
  'Rental length for section Host checkouts (e.g. 3h, 1d). Overrides product.vip_duration.';

INSERT INTO public.settings ("name", "value") VALUES
  ('hosted_servers.section_host_price_irr_per_hour', '500000'),
  ('hosted_servers.section_host_price_ypoint_per_hour', '50')
ON CONFLICT ("name") DO NOTHING;

-- Internal bill carrier for dynamic Host rentals (not sold as a catalog plan).
INSERT INTO public.store_products (
  slug, title, description, price_irr, price_ypoint, hosted_slots,
  vip_duration, hosted_section_mode, sort_order, active
) VALUES (
  'host-section-dynamic',
  'Host (custom)',
  'Internal carrier for Servers Host rentals priced by duration.',
  0, NULL, 20, '1d', 'any', 9998, false
)
ON CONFLICT (slug) DO UPDATE SET
  hosted_slots = 20,
  hosted_section_mode = 'any',
  active = false,
  updated_at = now();

-- Hide seed catalog plans; Host is configure-and-pay now.
UPDATE public.store_products
   SET active = false, updated_at = now()
 WHERE slug LIKE 'host-section-%'
   AND slug <> 'host-section-dynamic'
   AND hosted_section_mode IS NOT NULL;
