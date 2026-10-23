DELETE FROM public.hosted_servers WHERE club_id IS NOT NULL;

ALTER TABLE public.hosted_servers
  DROP COLUMN IF EXISTS club_id;
