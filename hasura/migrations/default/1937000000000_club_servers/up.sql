ALTER TABLE public.servers
  ADD COLUMN IF NOT EXISTS club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS servers_club_id_idx
  ON public.servers (club_id)
  WHERE club_id IS NOT NULL;
