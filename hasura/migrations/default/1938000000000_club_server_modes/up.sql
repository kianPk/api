ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS server_modes jsonb NOT NULL DEFAULT '{}'::jsonb;
