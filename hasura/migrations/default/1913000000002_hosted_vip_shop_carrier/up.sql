-- Inert bill carrier for hosted VIP shop (Bale). Must not have hosted_slots /
-- ypoint_amount / vip_* or payment fulfillment will treat the sale as a server buy.
INSERT INTO public.store_products
  (title, slug, description, price_irr, ypoint_amount, vip_server_id,
   vip_duration, hosted_slots, subscription_tier, sort_order, active)
VALUES (
  'Hosted VIP (internal)',
  'hosted-vip-shop',
  'Internal bill carrier for hosted server VIP sales. Not sold in the store.',
  0, NULL, NULL, NULL, NULL, NULL, 9999, false
)
ON CONFLICT (slug) DO NOTHING;
