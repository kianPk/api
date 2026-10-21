-- Re-clicking Request to join must not crash on club_join_requests_club_id_steam_id_key.
-- Pending stays pending; a denied/accepted row (after leaving) is reopened instead of inserted.

CREATE OR REPLACE FUNCTION public.tbi_club_join_requests_dedupe()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  existing public.club_join_requests%ROWTYPE;
  already_member boolean;
BEGIN
  SELECT * INTO existing
    FROM public.club_join_requests r
   WHERE r.club_id = NEW.club_id AND r.steam_id = NEW.steam_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF existing.status = 'pending' THEN
    RAISE EXCEPTION 'Join request already pending' USING ERRCODE = '22000';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.club_members m
     WHERE m.club_id = NEW.club_id AND m.steam_id = NEW.steam_id
  ) INTO already_member;

  IF already_member THEN
    RAISE EXCEPTION 'Already a club member' USING ERRCODE = '22000';
  END IF;

  UPDATE public.club_join_requests
     SET message = COALESCE(NEW.message, ''),
         status = 'pending',
         reviewed_by_steam_id = NULL,
         reviewed_at = NULL,
         created_at = now()
   WHERE id = existing.id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tbi_club_join_requests_dedupe ON public.club_join_requests;
CREATE TRIGGER tbi_club_join_requests_dedupe
  BEFORE INSERT ON public.club_join_requests
  FOR EACH ROW EXECUTE FUNCTION public.tbi_club_join_requests_dedupe();
