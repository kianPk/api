DELETE FROM public.store_products
 WHERE slug IN (
   'host-section-1h',
   'host-section-3h',
   'host-section-12h',
   'host-section-1d',
   'host-section-3d',
   'host-section-7d'
 );

ALTER TABLE public.servers DROP COLUMN IF EXISTS hosted_section;
ALTER TABLE public.hosted_servers DROP COLUMN IF EXISTS section_mode;
ALTER TABLE public.store_orders DROP COLUMN IF EXISTS hosted_section_mode;
ALTER TABLE public.store_products DROP COLUMN IF EXISTS hosted_section_mode;
