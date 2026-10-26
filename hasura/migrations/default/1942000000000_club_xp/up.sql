-- Club XP is the running sum of every member's club XP.
-- Join / leave / challenge awards keep it in sync via the trigger below.

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS xp integer NOT NULL DEFAULT 0;

ALTER TABLE public.clubs
  DROP CONSTRAINT IF EXISTS clubs_xp_check;
ALTER TABLE public.clubs
  ADD CONSTRAINT clubs_xp_check CHECK (xp >= 0);

COMMENT ON COLUMN public.clubs.xp IS
  'Sum of club_members.xp for current members. Updated on join, leave, and member XP changes.';

UPDATE public.clubs c
   SET xp = COALESCE((
     SELECT SUM(m.xp)::integer
       FROM public.club_members m
      WHERE m.club_id = c.id
   ), 0);

CREATE OR REPLACE FUNCTION public.club_members_sync_club_xp()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    delta := COALESCE(NEW.xp, 0);
    UPDATE public.clubs
       SET xp = GREATEST(0, xp + delta)
     WHERE id = NEW.club_id;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.club_id IS DISTINCT FROM OLD.club_id THEN
      UPDATE public.clubs
         SET xp = GREATEST(0, xp - COALESCE(OLD.xp, 0))
       WHERE id = OLD.club_id;
      UPDATE public.clubs
         SET xp = GREATEST(0, xp + COALESCE(NEW.xp, 0))
       WHERE id = NEW.club_id;
    ELSIF NEW.xp IS DISTINCT FROM OLD.xp THEN
      delta := COALESCE(NEW.xp, 0) - COALESCE(OLD.xp, 0);
      UPDATE public.clubs
         SET xp = GREATEST(0, xp + delta)
       WHERE id = NEW.club_id;
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE
  UPDATE public.clubs
     SET xp = GREATEST(0, xp - COALESCE(OLD.xp, 0))
   WHERE id = OLD.club_id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS club_members_sync_club_xp ON public.club_members;
CREATE TRIGGER club_members_sync_club_xp
  AFTER INSERT OR DELETE OR UPDATE OF xp, club_id
  ON public.club_members
  FOR EACH ROW
  EXECUTE FUNCTION public.club_members_sync_club_xp();
