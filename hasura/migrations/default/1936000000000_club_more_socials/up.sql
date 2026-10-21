ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS bale_url text,
  ADD COLUMN IF NOT EXISTS rubika_url text,
  ADD COLUMN IF NOT EXISTS soroush_url text;

ALTER TABLE public.clubs
  DROP CONSTRAINT IF EXISTS clubs_bale_url_len;
ALTER TABLE public.clubs
  ADD CONSTRAINT clubs_bale_url_len
  CHECK (bale_url IS NULL OR char_length(bale_url) BETWEEN 8 AND 200);

ALTER TABLE public.clubs
  DROP CONSTRAINT IF EXISTS clubs_rubika_url_len;
ALTER TABLE public.clubs
  ADD CONSTRAINT clubs_rubika_url_len
  CHECK (rubika_url IS NULL OR char_length(rubika_url) BETWEEN 8 AND 200);

ALTER TABLE public.clubs
  DROP CONSTRAINT IF EXISTS clubs_soroush_url_len;
ALTER TABLE public.clubs
  ADD CONSTRAINT clubs_soroush_url_len
  CHECK (soroush_url IS NULL OR char_length(soroush_url) BETWEEN 8 AND 200);
