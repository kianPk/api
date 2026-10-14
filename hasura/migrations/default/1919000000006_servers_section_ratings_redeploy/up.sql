-- Pick up section-ratings API + Duels/DM builds that persist Faceit Elo.
UPDATE public.servers SET enabled = false WHERE section_mode IN ('duels', 'dm');
UPDATE public.servers SET enabled = true WHERE section_mode IN ('duels', 'dm');
