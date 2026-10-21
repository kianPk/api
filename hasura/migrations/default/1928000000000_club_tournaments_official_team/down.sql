DROP TRIGGER IF EXISTS tai_tournaments_in_person_lan ON public.tournaments;
DROP FUNCTION IF EXISTS public.tai_tournaments_in_person_lan();

CREATE OR REPLACE FUNCTION public.tbi_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status = 'Finished' AND NEW.finished_at IS NULL THEN
        NEW.finished_at := now();
    END IF;

    IF NEW.discord_notifications_enabled IS NULL THEN
        IF EXISTS (
            SELECT 1
            FROM public.settings
            WHERE name LIKE 'discord_match_notify_%'
              AND value = 'true'
        ) THEN
            NEW.discord_notifications_enabled := true;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbi_clubs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base_slug text;
  candidate text;
  n int := 0;
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    base_slug := public.slugify_club_name(NEW.name);
    candidate := base_slug;
    WHILE EXISTS (SELECT 1 FROM public.clubs c WHERE c.slug = candidate) LOOP
      n := n + 1;
      candidate := base_slug || '-' || n::text;
    END LOOP;
    NEW.slug := candidate;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

ALTER TABLE public.tournaments DROP COLUMN IF EXISTS club_id;
ALTER TABLE public.tournaments DROP COLUMN IF EXISTS participation_mode;
ALTER TABLE public.clubs DROP COLUMN IF EXISTS official_team_id;
DROP TABLE IF EXISTS public.e_tournament_participation_modes;
