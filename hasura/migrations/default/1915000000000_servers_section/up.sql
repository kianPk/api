ALTER TABLE public.servers
    ADD COLUMN IF NOT EXISTS section_mode text;

ALTER TABLE public.servers
    DROP CONSTRAINT IF EXISTS servers_section_mode_check;
ALTER TABLE public.servers
    ADD CONSTRAINT servers_section_mode_check
    CHECK (section_mode IS NULL OR section_mode IN ('duels', 'awp', '2x2'));

CREATE INDEX IF NOT EXISTS servers_section_mode_idx
    ON public.servers (section_mode)
    WHERE section_mode IS NOT NULL;

-- A Servers-section server is whatever its mode says it is. Its rules and
-- plugins come from the api (server-section-modes.ts); type and slots are
-- forced here so no edit through the server form can drift one server of a
-- mode away from the rest.
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

DROP TRIGGER IF EXISTS tbiu_servers_section_mode ON public.servers;
CREATE TRIGGER tbiu_servers_section_mode
    BEFORE INSERT OR UPDATE ON public.servers
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_servers_section_mode();

-- Duels, AWP and 2x2 used to be game modes a server was assigned to. Servers
-- already running one move into the Servers section under the same mode.
UPDATE public.servers s
   SET section_mode = gm.slug
  FROM public.game_modes gm
 WHERE s.game_mode_id = gm.id
   AND gm.slug IN ('duels', 'awp', '2x2');

UPDATE public.servers s
   SET label = CASE r.section_mode
                 WHEN 'duels' THEN 'Duels'
                 WHEN 'awp' THEN 'AWP'
                 ELSE '2x2'
               END || ' #' || r.n
  FROM (
    SELECT id,
           section_mode,
           row_number() OVER (PARTITION BY section_mode ORDER BY label, id) AS n
      FROM public.servers
     WHERE section_mode IS NOT NULL
  ) r
 WHERE s.id = r.id;

-- A mode a match has used stays for history, archived out of every picker.
UPDATE public.game_modes gm
   SET enabled = false,
       archived_at = COALESCE(gm.archived_at, now())
 WHERE gm.slug IN ('duels', 'awp', '2x2')
   AND EXISTS (SELECT 1 FROM public.match_options mo WHERE mo.game_mode_id = gm.id);

DELETE FROM public.game_modes gm
 WHERE gm.slug IN ('duels', 'awp', '2x2')
   AND NOT EXISTS (SELECT 1 FROM public.match_options mo WHERE mo.game_mode_id = gm.id);
