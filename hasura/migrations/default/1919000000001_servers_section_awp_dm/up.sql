-- AWP becomes a deathmatch, as xplay's AWP DM. Moving its servers to the new
-- type also redeploys them through the servers event, onto the new cfg.
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
        WHEN 'awp' THEN 'Deathmatch'
        ELSE 'Casual'
    END;
    NEW.max_players := CASE NEW.section_mode
        WHEN 'duels' THEN 18
        WHEN 'dm' THEN 18
        WHEN 'bhop' THEN 20
        WHEN 'awp' THEN 20
        ELSE 4
    END;

    RETURN NEW;
END;
$$;

UPDATE public.servers SET type = 'Deathmatch' WHERE section_mode = 'awp';
