DROP TRIGGER IF EXISTS club_members_sync_club_xp ON public.club_members;
DROP FUNCTION IF EXISTS public.club_members_sync_club_xp();
ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_xp_check;
ALTER TABLE public.clubs DROP COLUMN IF EXISTS xp;
