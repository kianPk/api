-- Club ownership requires the OwnClub player tag (granted by site admins).
-- Leaving a club starts an escalating join lock: 2 days, then 7, 14, 21, ...

CREATE TABLE IF NOT EXISTS public.player_tags (
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  tag text NOT NULL,
  granted_by_steam_id bigint REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (steam_id, tag),
  CONSTRAINT player_tags_tag_len CHECK (char_length(tag) BETWEEN 1 AND 32)
);
CREATE INDEX IF NOT EXISTS player_tags_tag_idx ON public.player_tags (tag);

CREATE TABLE IF NOT EXISTS public.club_leave_cooldowns (
  steam_id bigint PRIMARY KEY REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  leave_count integer NOT NULL DEFAULT 0,
  last_left_at timestamptz,
  blocked_until timestamptz
);

CREATE OR REPLACE FUNCTION public.club_clan_tag(p_short text, p_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(
    upper(trim(both from regexp_replace(
      COALESCE(NULLIF(btrim(COALESCE(p_short, '')), ''), left(COALESCE(p_name, ''), 5)),
      '[][]',
      '',
      'g'
    ))),
    5
  );
$$;

CREATE OR REPLACE FUNCTION public.player_can_own_club(p_steam bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.player_tags t
    WHERE t.steam_id = p_steam AND t.tag = 'OwnClub'
  ) OR EXISTS (
    SELECT 1 FROM public.players p
    WHERE p.steam_id = p_steam AND p.role = 'administrator'
  );
$$;

CREATE OR REPLACE FUNCTION public.club_leave_cooldown_interval(p_leave_count integer)
RETURNS interval LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN COALESCE(p_leave_count, 0) <= 1 THEN interval '2 days'
    ELSE ((7 * GREATEST(p_leave_count - 1, 1))::text || ' days')::interval
  END;
$$;

CREATE OR REPLACE FUNCTION public.assert_club_join_allowed(p_steam bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  until_at timestamptz;
BEGIN
  SELECT blocked_until INTO until_at
  FROM public.club_leave_cooldowns
  WHERE steam_id = p_steam AND blocked_until IS NOT NULL AND blocked_until > now();
  IF until_at IS NOT NULL THEN
    RAISE EXCEPTION 'club_join_cooldown:%', until_at
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbi_clubs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base_slug text;
  candidate text;
  n int := 0;
BEGIN
  IF TG_OP = 'INSERT'
     OR (TG_OP = 'UPDATE' AND NEW.owner_steam_id IS DISTINCT FROM OLD.owner_steam_id)
  THEN
    IF NOT public.player_can_own_club(NEW.owner_steam_id) THEN
      RAISE EXCEPTION 'own_club_tag_required'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

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

CREATE OR REPLACE FUNCTION public.tbi_club_members_join()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.club_members
    WHERE club_id = NEW.club_id AND steam_id = NEW.steam_id
  ) THEN
    RETURN NEW;
  END IF;
  IF NEW.role IS DISTINCT FROM 'owner' THEN
    PERFORM public.assert_club_join_allowed(NEW.steam_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tbi_club_members_join ON public.club_members;
CREATE TRIGGER tbi_club_members_join
  BEFORE INSERT ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.tbi_club_members_join();

CREATE OR REPLACE FUNCTION public.tbi_club_join_requests_cooldown()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS NULL OR NEW.status = 'pending' THEN
    PERFORM public.assert_club_join_allowed(NEW.steam_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tbi_club_join_requests_cooldown ON public.club_join_requests;
CREATE TRIGGER tbi_club_join_requests_cooldown
  BEFORE INSERT ON public.club_join_requests
  FOR EACH ROW EXECUTE FUNCTION public.tbi_club_join_requests_cooldown();

CREATE OR REPLACE FUNCTION public.tad_club_members_leave()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = OLD.club_id) THEN
    RETURN OLD;
  END IF;

  INSERT INTO public.club_leave_cooldowns (steam_id, leave_count, last_left_at, blocked_until)
  VALUES (OLD.steam_id, 1, now(), now() + public.club_leave_cooldown_interval(1))
  ON CONFLICT (steam_id) DO UPDATE SET
    leave_count = public.club_leave_cooldowns.leave_count + 1,
    last_left_at = now(),
    blocked_until = now() + public.club_leave_cooldown_interval(
      public.club_leave_cooldowns.leave_count + 1
    );

  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS tad_club_members_leave ON public.club_members;
CREATE TRIGGER tad_club_members_leave
  AFTER DELETE ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.tad_club_members_leave();
