UPDATE public.store_products
   SET active = true, updated_at = now()
 WHERE slug LIKE 'host-section-%'
   AND slug <> 'host-section-dynamic'
   AND hosted_section_mode IS NOT NULL;

DELETE FROM public.store_products WHERE slug = 'host-section-dynamic';
DELETE FROM public.settings
 WHERE name IN (
   'hosted_servers.section_host_price_irr_per_hour',
   'hosted_servers.section_host_price_ypoint_per_hour'
 );

ALTER TABLE public.store_orders DROP COLUMN IF EXISTS hosted_duration;