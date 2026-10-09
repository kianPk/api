DELETE FROM public.servers WHERE section_mode IN ('dm', 'bhop');

DELETE FROM public.settings
 WHERE name IN (
    'servers_section_dm',
    'servers_section_dm_maps',
    'servers_section_bhop',
    'servers_section_bhop_maps'
 );

ALTER TABLE public.servers
    DROP CONSTRAINT IF EXISTS servers_section_mode_check;
ALTER TABLE public.servers
    ADD CONSTRAINT servers_section_mode_check
    CHECK (section_mode IS NULL OR section_mode IN ('duels', 'awp', '2x2'));

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
        ELSE 'Casual'
    END;
    NEW.max_players := CASE NEW.section_mode
        WHEN 'duels' THEN 18
        WHEN 'awp' THEN 20
        ELSE 4
    END;

    RETURN NEW;
END;
$$;

INSERT INTO public.settings (name, value)
VALUES ('servers_section_awp', '1')
ON CONFLICT (name) DO NOTHING;
