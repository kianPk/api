-- Timed chat advertisements controlled by the hosted-server owner.
ALTER TABLE public.hosted_servers
  ADD COLUMN IF NOT EXISTS chat_ads_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS chat_ads_interval_seconds integer NOT NULL DEFAULT 120
    CHECK (chat_ads_interval_seconds BETWEEN 30 AND 900),
  ADD COLUMN IF NOT EXISTS chat_ads_messages jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.hosted_servers.chat_ads_enabled IS
  'When true, YGuardAdmin rotates chat_ads_messages into in-game chat';
COMMENT ON COLUMN public.hosted_servers.chat_ads_interval_seconds IS
  'Seconds between chat ad broadcasts (30–900)';
COMMENT ON COLUMN public.hosted_servers.chat_ads_messages IS
  'JSON array of plain-text chat ad lines (max 5)';
