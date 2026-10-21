ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_bale_url_len;
ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_rubika_url_len;
ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_soroush_url_len;
ALTER TABLE public.clubs
  DROP COLUMN IF EXISTS bale_url,
  DROP COLUMN IF EXISTS rubika_url,
  DROP COLUMN IF EXISTS soroush_url;
