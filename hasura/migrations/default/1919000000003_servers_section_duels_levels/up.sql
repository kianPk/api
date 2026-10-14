-- Redeploy Duels so they pick up multiaddonmanager (Faceit level pins) and
-- the new servers-duels build that writes Rank[5] from Elo.
UPDATE public.servers SET enabled = false WHERE section_mode = 'duels';
UPDATE public.servers SET enabled = true WHERE section_mode = 'duels';
