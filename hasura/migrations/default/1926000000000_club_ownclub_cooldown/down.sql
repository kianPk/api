DROP TRIGGER IF EXISTS tad_club_members_leave ON public.club_members;
DROP FUNCTION IF EXISTS public.tad_club_members_leave();
DROP TRIGGER IF EXISTS tbi_club_join_requests_cooldown ON public.club_join_requests;
DROP FUNCTION IF EXISTS public.tbi_club_join_requests_cooldown();
DROP TRIGGER IF EXISTS tbi_club_members_join ON public.club_members;
DROP FUNCTION IF EXISTS public.tbi_club_members_join();
DROP FUNCTION IF EXISTS public.assert_club_join_allowed(bigint);
DROP FUNCTION IF EXISTS public.club_leave_cooldown_interval(integer);
DROP FUNCTION IF EXISTS public.player_can_own_club(bigint);
DROP FUNCTION IF EXISTS public.club_clan_tag(text, text);
DROP TABLE IF EXISTS public.club_leave_cooldowns;
DROP TABLE IF EXISTS public.player_tags;

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
