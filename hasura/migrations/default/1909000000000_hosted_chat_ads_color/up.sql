-- Chat ad accent colour chosen by the hosted-server owner.
ALTER TABLE public.hosted_servers
  ADD COLUMN IF NOT EXISTS chat_ads_color text NOT NULL DEFAULT 'gold'
    CHECK (chat_ads_color IN (
      'gold', 'green', 'blue', 'red', 'purple', 'lightred', 'white', 'grey'
    ));

COMMENT ON COLUMN public.hosted_servers.chat_ads_color IS
  'Accent colour for [AD] prefix in timed chat advertisements';
