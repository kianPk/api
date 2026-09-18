DROP TABLE IF EXISTS public.ac_pair_codes;
DROP TABLE IF EXISTS public.ac_attestations;
DROP TABLE IF EXISTS public.ac_devices;
DELETE FROM public.settings WHERE name LIKE 'public.ac_%';
