-- AWP leaves the Servers section; Deathmatch and BHOP, as xplay runs them,
-- take its place. Its servers go the way any section server goes when a
-- mode's count comes down.
DELETE FROM public.servers WHERE section_mode = 'awp';

DELETE FROM public.settings
 WHERE name IN ('servers_section_awp', 'servers_section_awp_maps');

ALTER TABLE public.servers
    DROP CONSTRAINT IF EXISTS servers_section_mode_check;
ALTER TABLE public.servers
    ADD CONSTRAINT servers_section_mode_check
    CHECK (section_mode IS NULL OR section_mode IN ('duels', 'dm', 'bhop', '2x2'));

CREATE OR REPLACE FUNCTION public.tbiu_servers_section_mode() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.section_mode IS NULL THEN
        RETURN NEW;
    END IF;

    NEW.is_dedicated := true;
    NEW.game_mode_id := NULL;
    NEW.connect_password := NULL;
    NEW.type := CASE NEW.section_mode
        WHEN '2x2' THEN 'Wingman'
        WHEN 'duels' THEN 'Deathmatch'
        WHEN 'dm' THEN 'Deathmatch'
        ELSE 'Casual'
    END;
    NEW.max_players := CASE NEW.section_mode
        WHEN 'duels' THEN 18
        WHEN 'dm' THEN 18
        WHEN 'bhop' THEN 20
        ELSE 4
    END;

    RETURN NEW;
END;
$$;

INSERT INTO public.settings (name, value)
VALUES
    ('servers_section_dm', '1'),
    ('servers_section_bhop', '1')
ON CONFLICT (name) DO NOTHING;
