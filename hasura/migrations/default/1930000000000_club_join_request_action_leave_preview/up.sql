-- Join requests: stop BEFORE INSERT from cancelling/raising (Hasura shows
-- "database query error"). Upsert is handled by requestClubJoin.
-- Leave cooldown: escalate inside a week; reset to the first lock after 7 days.

DROP TRIGGER IF EXISTS tbi_club_join_requests_dedupe ON public.club_join_requests;
DROP FUNCTION IF EXISTS public.tbi_club_join_requests_dedupe();

CREATE OR REPLACE FUNCTION public.club_leave_next_count(p_steam bigint)
RETURNS integer LANGUAGE plpgsql STABLE AS $$
DECLARE
  rec record;
BEGIN
  SELECT leave_count, last_left_at
    INTO rec
    FROM public.club_leave_cooldowns
   WHERE steam_id = p_steam;
  IF NOT FOUND THEN
    RETURN 1;
  END IF;
  IF rec.last_left_at IS NULL OR rec.last_left_at <= now() - interval '7 days' THEN
    RETURN 1;
  END IF;
  RETURN GREATEST(COALESCE(rec.leave_count, 0), 0) + 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.preview_club_leave_block(p_steam bigint)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT now() + public.club_leave_cooldown_interval(public.club_leave_next_count(p_steam));
$$;

CREATE OR REPLACE FUNCTION public.tad_club_members_leave()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  next_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = OLD.club_id) THEN
    RETURN OLD;
  END IF;

  next_count := public.club_leave_next_count(OLD.steam_id);

  INSERT INTO public.club_leave_cooldowns (steam_id, leave_count, last_left_at, blocked_until)
  VALUES (
    OLD.steam_id,
    next_count,
    now(),
    now() + public.club_leave_cooldown_interval(next_count)
  )
  ON CONFLICT (steam_id) DO UPDATE SET
    leave_count = EXCLUDED.leave_count,
    last_left_at = EXCLUDED.last_left_at,
    blocked_until = EXCLUDED.blocked_until;

  RETURN OLD;
END;
$$;
