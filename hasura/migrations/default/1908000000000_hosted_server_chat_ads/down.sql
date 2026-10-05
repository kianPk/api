ALTER TABLE public.hosted_servers
  DROP COLUMN IF EXISTS chat_ads_messages,
  DROP COLUMN IF EXISTS chat_ads_interval_seconds,
  DROP COLUMN IF EXISTS chat_ads_enabled;
