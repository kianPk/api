ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS telegram_url text,
  ADD COLUMN IF NOT EXISTS instagram_url text;

ALTER TABLE public.clubs
  DROP CONSTRAINT IF EXISTS clubs_telegram_url_len;
ALTER TABLE public.clubs
  ADD CONSTRAINT clubs_telegram_url_len
  CHECK (telegram_url IS NULL OR char_length(telegram_url) BETWEEN 8 AND 200);

ALTER TABLE public.clubs
  DROP CONSTRAINT IF EXISTS clubs_instagram_url_len;
ALTER TABLE public.clubs
  ADD CONSTRAINT clubs_instagram_url_len
  CHECK (instagram_url IS NULL OR char_length(instagram_url) BETWEEN 8 AND 200);
