DROP TRIGGER IF EXISTS club_members_sync_role ON public.club_members;
DROP FUNCTION IF EXISTS public.sync_club_member_role_from_level();
DROP FUNCTION IF EXISTS public.club_role_from_level(integer);
DROP FUNCTION IF EXISTS public.club_can_post_news(uuid, bigint);

CREATE OR REPLACE FUNCTION public.can_manage_club(p_club uuid, p_steam bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members m
    WHERE m.club_id = p_club AND m.steam_id = p_steam
      AND m.role IN ('owner', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.can_moderate_club(p_club uuid, p_steam bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members m
    WHERE m.club_id = p_club AND m.steam_id = p_steam
      AND m.role IN ('owner', 'admin', 'moderator')
  );
$$;

DROP TABLE IF EXISTS public.club_member_perm_overrides;

ALTER TABLE public.clubs DROP COLUMN IF EXISTS level_permissions;

ALTER TABLE public.club_members
  DROP CONSTRAINT IF EXISTS club_members_level_check,
  DROP CONSTRAINT IF EXISTS club_members_xp_check,
  DROP CONSTRAINT IF EXISTS club_members_staff_level_check;

ALTER TABLE public.club_members
  DROP COLUMN IF EXISTS level,
  DROP COLUMN IF EXISTS xp,
  DROP COLUMN IF EXISTS title,
  DROP COLUMN IF EXISTS staff_level,
  DROP COLUMN IF EXISTS club_vip_until;

DELETE FROM public.e_club_roles WHERE value = 'co_owner';
