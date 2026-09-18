-- YGuard AC client-side cheat signature hits (e.g. ExLoader)

CREATE TABLE IF NOT EXISTS public.ac_detections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON DELETE CASCADE,
  device_id uuid REFERENCES public.ac_devices(id) ON DELETE SET NULL,
  signature text NOT NULL,
  path text,
  process_name text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  banned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ac_detections_steam_created_idx
  ON public.ac_detections (steam_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ac_detections_signature_idx
  ON public.ac_detections (signature);
