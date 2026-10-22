DROP INDEX IF EXISTS public.servers_club_id_idx;

ALTER TABLE public.servers
  DROP COLUMN IF EXISTS club_id;
