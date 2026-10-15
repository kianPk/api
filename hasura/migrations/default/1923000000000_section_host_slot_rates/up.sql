-- Host: base includes 10 slots; each extra slot billed per hour.

INSERT INTO public.settings ("name", "value") VALUES
  ('hosted_servers.section_host_slot_price_irr_per_hour', '50000'),
  ('hosted_servers.section_host_slot_price_ypoint_per_hour', '5')
ON CONFLICT ("name") DO NOTHING;
