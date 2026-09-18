-- Harden AC devices: bind hardware, one-time attest challenges

ALTER TABLE public.ac_devices
  ADD COLUMN IF NOT EXISTS hardware_hash text,
  ADD COLUMN IF NOT EXISTS client_version text;

CREATE TABLE IF NOT EXISTS public.ac_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES public.ac_devices(id) ON DELETE CASCADE,
  challenge_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ac_challenges_device_idx
  ON public.ac_challenges (device_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS ac_challenges_cleanup_idx
  ON public.ac_challenges (expires_at)
  WHERE used_at IS NULL;
