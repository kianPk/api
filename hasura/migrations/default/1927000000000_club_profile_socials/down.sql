ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_telegram_url_len;
ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_instagram_url_len;
ALTER TABLE public.clubs DROP COLUMN IF EXISTS telegram_url;
ALTER TABLE public.clubs DROP COLUMN IF EXISTS instagram_url;
