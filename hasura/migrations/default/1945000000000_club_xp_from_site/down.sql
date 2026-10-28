DROP TRIGGER IF EXISTS player_site_xp_sync_club_members ON public.player_site_xp;
DROP FUNCTION IF EXISTS public.player_site_xp_sync_club_members();

COMMENT ON COLUMN public.club_members.xp IS
  'Challenge XP toward auto levels 1–6.';

COMMENT ON COLUMN public.clubs.xp IS
  'Sum of club_members.xp for current members. Updated on join, leave, and member XP changes.';
