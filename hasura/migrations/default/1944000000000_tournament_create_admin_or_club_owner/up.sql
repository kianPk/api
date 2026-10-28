-- Tournament create: site admins only via role gate; club owners still pass
-- Hasura insert check via club.owner_steam_id = session user.
INSERT INTO public.settings (name, value)
VALUES ('public.create_tournaments_role', 'administrator')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;
