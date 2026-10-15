DELETE FROM public.settings
 WHERE name IN (
   'hosted_servers.section_host_slot_price_irr_per_hour',
   'hosted_servers.section_host_slot_price_ypoint_per_hour'
 );
