-- Club member levels (1–10) replace role as source of truth. Role is synced from level.

INSERT INTO public.e_club_roles (value, description) VALUES
  ('co_owner', 'Club co-owner')
ON CONFLICT (value) DO NOTHING;

ALTER TABLE public.club_members
  ADD COLUMN IF NOT EXISTS level integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS xp integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS staff_level integer,
  ADD COLUMN IF NOT EXISTS club_vip_until timestamptz;

ALTER TABLE public.club_members
  DROP CONSTRAINT IF EXISTS club_members_level_check;
ALTER TABLE public.club_members
  ADD CONSTRAINT club_members_level_check CHECK (level BETWEEN 1 AND 10);

ALTER TABLE public.club_members
  DROP CONSTRAINT IF EXISTS club_members_xp_check;
ALTER TABLE public.club_members
  ADD CONSTRAINT club_members_xp_check CHECK (xp >= 0);

ALTER TABLE public.club_members
  DROP CONSTRAINT IF EXISTS club_members_staff_level_check;
ALTER TABLE public.club_members
  ADD CONSTRAINT club_members_staff_level_check
  CHECK (staff_level IS NULL OR staff_level BETWEEN 7 AND 10);

COMMENT ON COLUMN public.club_members.level IS
  'Effective club rank 1–10. Role is derived from this.';
COMMENT ON COLUMN public.club_members.xp IS
  'Challenge XP toward auto levels 1–6.';
COMMENT ON COLUMN public.club_members.title IS
  'Custom title for level 7+ (owner-set).';
COMMENT ON COLUMN public.club_members.staff_level IS
  'Owner-assigned rank floor 7–10. NULL = auto rank from VIP/XP only (max 6).';
COMMENT ON COLUMN public.club_members.club_vip_until IS
  'Active until when the member has club-wide VIP (all club servers).';

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS level_permissions jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.clubs.level_permissions IS
  'Per-level permission map. Keys are permission names; values are min level or bool overrides per level object.';

CREATE TABLE IF NOT EXISTS public.club_member_perm_overrides (
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  perm_key text NOT NULL,
  allowed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, steam_id, perm_key)
);
CREATE INDEX IF NOT EXISTS club_member_perm_overrides_steam_idx
  ON public.club_member_perm_overrides (steam_id);

-- Default level permission matrix (min level required for each permission).
-- Clubs can override via level_permissions jsonb: { "post_news": { "min": 8 }, ... }
-- or per-level flags: { "post_news": { "levels": { "7": false, "8": true } } }
UPDATE public.clubs
SET level_permissions = '{
  "post_news": {"min": 8},
  "moderate_news": {"min": 8},
  "manage_members": {"min": 8},
  "manage_invites": {"min": 8},
  "manage_requests": {"min": 8},
  "manage_bans": {"min": 8},
  "manage_servers": {"min": 8},
  "manage_challenges": {"min": 8},
  "manage_settings": {"min": 9},
  "manage_levels": {"min": 10},
  "set_titles": {"min": 10},
  "set_staff_level": {"min": 10}
}'::jsonb
WHERE level_permissions = '{}'::jsonb OR level_permissions IS NULL;

-- Backfill levels from existing roles.
UPDATE public.club_members m
SET
  level = CASE m.role
    WHEN 'owner' THEN 10
    WHEN 'co_owner' THEN 9
    WHEN 'admin' THEN 8
    WHEN 'moderator' THEN 7
    ELSE 1
  END,
  staff_level = CASE m.role
    WHEN 'owner' THEN 10
    WHEN 'co_owner' THEN 9
    WHEN 'admin' THEN 8
    WHEN 'moderator' THEN 7
    ELSE NULL
  END,
  title = CASE
    WHEN m.role = 'moderator' AND (m.title IS NULL OR m.title = '') THEN 'VIP'
    ELSE m.title
  END,
  is_vip = CASE
    WHEN m.role IN ('owner', 'co_owner', 'admin', 'moderator') THEN true
    ELSE m.is_vip
  END;

-- Keep owners pinned to level 10 / staff 10.
UPDATE public.club_members m
SET level = 10, staff_level = 10, role = 'owner'
FROM public.clubs c
WHERE c.id = m.club_id AND m.steam_id = c.owner_steam_id;

CREATE OR REPLACE FUNCTION public.club_role_from_level(p_level integer)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_level >= 10 THEN 'owner'
    WHEN p_level = 9 THEN 'co_owner'
    WHEN p_level = 8 THEN 'admin'
    ELSE 'member'
  END;
$$;

CREATE OR REPLACE FUNCTION public.sync_club_member_role_from_level()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.role := public.club_role_from_level(NEW.level);
  IF NEW.level >= 2 THEN
    NEW.is_vip := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS club_members_sync_role ON public.club_members;
CREATE TRIGGER club_members_sync_role
  BEFORE INSERT OR UPDATE OF level ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_club_member_role_from_level();

-- Re-sync roles after backfill (trigger only fires on level changes going forward).
UPDATE public.club_members
SET role = public.club_role_from_level(level);

CREATE OR REPLACE FUNCTION public.can_manage_club(p_club uuid, p_steam bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members m
    WHERE m.club_id = p_club AND m.steam_id = p_steam
      AND (m.level >= 8 OR m.role IN ('owner', 'co_owner', 'admin'))
  );
$$;

CREATE OR REPLACE FUNCTION public.can_moderate_club(p_club uuid, p_steam bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members m
    WHERE m.club_id = p_club AND m.steam_id = p_steam
      AND (m.level >= 7 OR m.role IN ('owner', 'co_owner', 'admin', 'moderator'))
  );
$$;

-- Owner row on club create: pin level 10.
CREATE OR REPLACE FUNCTION public.club_can_post_news(p_club uuid, p_steam bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.club_members m
      JOIN public.clubs c ON c.id = m.club_id
      LEFT JOIN public.club_member_perm_overrides o
        ON o.club_id = m.club_id
       AND o.steam_id = m.steam_id
       AND o.perm_key = 'post_news'
     WHERE m.club_id = p_club AND m.steam_id = p_steam
       AND (
         o.allowed IS TRUE
         OR (
           o.allowed IS DISTINCT FROM FALSE
           AND (
             m.level >= COALESCE(
               NULLIF((c.level_permissions -> 'post_news' ->> 'min'), '')::int,
               8
             )
             OR COALESCE(
               (c.level_permissions -> 'post_news' -> 'levels' ->> m.level::text)::boolean,
               false
             )
           )
         )
       )
  );
$$;

CREATE OR REPLACE FUNCTION public.tai_clubs_after()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.club_members (
    club_id, steam_id, role, level, staff_level, is_primary, is_vip
  )
  VALUES (NEW.id, NEW.owner_steam_id, 'owner', 10, 10, false, true)
  ON CONFLICT (club_id, steam_id) DO UPDATE
    SET role = 'owner', level = 10, staff_level = 10, is_vip = true;

  INSERT INTO public.club_channels (club_id, name, slug)
  VALUES (NEW.id, 'general', 'general')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.club_leaderboards (club_id, name, type, starting_points)
  VALUES (NEW.id, 'All-Time', 'all_time', 1000);

  INSERT INTO public.club_activity (club_id, actor_steam_id, kind, payload)
  VALUES (NEW.id, NEW.owner_steam_id, 'club_created', jsonb_build_object('name', NEW.name));

  RETURN NEW;
END;
$$;
