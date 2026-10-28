-- Club member XP mirrors site XP (player_site_xp). Club strength (clubs.xp)
-- stays the sum of members' XP via the existing club_members_sync_club_xp trigger.

COMMENT ON COLUMN public.club_members.xp IS
  'Mirror of player_site_xp.xp for this member. Club strength is the sum of these.';

COMMENT ON COLUMN public.clubs.xp IS
  'Sum of members'' site XP (via club_members.xp). Measures how strong the club is.';

CREATE OR REPLACE FUNCTION public.player_site_xp_sync_club_members()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.club_members
     SET xp = GREATEST(0, COALESCE(NEW.xp, 0))
   WHERE steam_id = NEW.steam_id
     AND xp IS DISTINCT FROM GREATEST(0, COALESCE(NEW.xp, 0));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS player_site_xp_sync_club_members ON public.player_site_xp;
CREATE TRIGGER player_site_xp_sync_club_members
  AFTER INSERT OR UPDATE OF xp ON public.player_site_xp
  FOR EACH ROW
  EXECUTE FUNCTION public.player_site_xp_sync_club_members();

-- One-shot backfill: each club member shows their current site XP.
UPDATE public.club_members m
   SET xp = GREATEST(0, COALESCE(s.xp, 0))
  FROM public.player_site_xp s
 WHERE s.steam_id = m.steam_id
   AND m.xp IS DISTINCT FROM GREATEST(0, COALESCE(s.xp, 0));

UPDATE public.club_members m
   SET xp = 0
 WHERE NOT EXISTS (
         SELECT 1 FROM public.player_site_xp s WHERE s.steam_id = m.steam_id
       )
   AND m.xp <> 0;

-- Recompute club totals from the mirrored member XP.
UPDATE public.clubs c
   SET xp = COALESCE((
     SELECT SUM(m.xp)::integer
       FROM public.club_members m
      WHERE m.club_id = c.id
   ), 0);
