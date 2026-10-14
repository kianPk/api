-- Force the servers event to redeploy AWP onto the cfg that turns
-- INVULNERABLE off (mp_respawn_immunitytime -1).
UPDATE public.servers SET enabled = false WHERE section_mode = 'awp';
UPDATE public.servers SET enabled = true WHERE section_mode = 'awp';
