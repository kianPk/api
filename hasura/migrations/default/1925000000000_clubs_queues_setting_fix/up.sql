-- Feature flag belongs in public.settings (SystemService).
INSERT INTO public.settings (name, value)
VALUES ('public.clubs_queues_enabled', 'false')
ON CONFLICT (name) DO NOTHING;
