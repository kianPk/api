DROP TABLE IF EXISTS public.ac_challenges;

ALTER TABLE public.ac_devices
  DROP COLUMN IF EXISTS client_version,
  DROP COLUMN IF EXISTS hardware_hash;
