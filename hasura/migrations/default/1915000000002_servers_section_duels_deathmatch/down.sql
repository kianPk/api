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
    NEW.type := CASE NEW.section_mode WHEN '2x2' THEN 'Wingman' ELSE 'Casual' END;
    NEW.max_players := CASE NEW.section_mode
        WHEN 'duels' THEN 18
        WHEN 'awp' THEN 20
        ELSE 4
    END;

    RETURN NEW;
END;
$$;

UPDATE public.servers
   SET type = 'Casual'
 WHERE section_mode = 'duels';
