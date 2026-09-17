-- Trios match fee (12 Ypoints) + admin switch for free ranked play modes
INSERT INTO public.settings (name, value) VALUES
  ('public.ypoint_cost_trios', '12'),
  ('public.ypoint_ranked_free', 'false')
ON CONFLICT (name) DO NOTHING;

UPDATE public.settings SET value = '12' WHERE name = 'public.ypoint_cost_trios';
