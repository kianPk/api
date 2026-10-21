-- Club-tagged tournaments (online vs in-person) and one official team per club.

CREATE TABLE IF NOT EXISTS public.e_tournament_participation_modes (
  value text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO public.e_tournament_participation_modes (value, description) VALUES
  ('online', 'Public online — any site member can play remotely'),
  ('in_person', 'In-person / game-net — any site member can register; matches run on LAN PCs')
ON CONFLICT (value) DO NOTHING;

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS club_id uuid REFERENCES public.clubs(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS participation_mode text NOT NULL DEFAULT 'online'
    REFERENCES public.e_tournament_participation_modes(value);

CREATE INDEX IF NOT EXISTS tournaments_club_idx ON public.tournaments (club_id);

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS official_team_id uuid UNIQUE REFERENCES public.teams(id)
    ON UPDATE CASCADE ON DELETE SET NULL;

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

    IF NEW.club_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.clubs c
            WHERE c.id = NEW.club_id
              AND c.owner_steam_id = NEW.organizer_steam_id
        ) THEN
            RAISE EXCEPTION 'Only the club owner can tag a tournament with that club'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF NEW.participation_mode = 'in_person'
       AND (NEW.location IS NULL OR btrim(NEW.location) = '') THEN
        RAISE EXCEPTION 'In-person tournaments need a venue' USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_tournaments ON public.tournaments;
CREATE TRIGGER tbi_tournaments
    BEFORE INSERT OR UPDATE ON public.tournaments
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_tournaments();

CREATE OR REPLACE FUNCTION public.tai_tournaments_in_person_lan()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.participation_mode = 'in_person' AND NEW.match_options_id IS NOT NULL THEN
    UPDATE public.match_options
    SET region_veto = false,
        regions = COALESCE(
          (SELECT array_agg(value) FROM public.server_regions WHERE is_lan IS TRUE),
          regions
        )
    WHERE id = NEW.match_options_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_tournaments_in_person_lan ON public.tournaments;
CREATE TRIGGER tai_tournaments_in_person_lan
  AFTER INSERT OR UPDATE OF participation_mode, match_options_id ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.tai_tournaments_in_person_lan();

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
    WHILE EXISTS (SELECT 1 FROM public.clubs c WHERE c.slug = candidate AND c.id <> NEW.id) LOOP
      n := n + 1;
      candidate := base_slug || '-' || n::text;
    END LOOP;
    NEW.slug := candidate;
  END IF;
  NEW.updated_at := now();

  IF NEW.official_team_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.teams t
      WHERE t.id = NEW.official_team_id
        AND t.owner_steam_id = NEW.owner_steam_id
    ) THEN
      RAISE EXCEPTION 'Official team must be owned by the club owner'
        USING ERRCODE = '22000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
