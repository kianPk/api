DELETE FROM public.settings WHERE "name" LIKE 'hosted_servers.%';

DELETE FROM public.e_notification_types
  WHERE "value" IN ('HostedServerReady', 'HostedServerExpiring', 'HostedServerExpired', 'HostedServerFailed');

DROP INDEX IF EXISTS public.store_orders_hosted_unfulfilled_idx;

ALTER TABLE public.store_orders
  DROP COLUMN IF EXISTS hosted_fulfilled_at,
  DROP COLUMN IF EXISTS hosted_label,
  DROP COLUMN IF EXISTS hosted_type,
  DROP COLUMN IF EXISTS hosted_server_id,
  DROP COLUMN IF EXISTS hosted_kind;

DROP TABLE IF EXISTS public.hosted_servers;

ALTER TABLE public.store_products DROP COLUMN IF EXISTS hosted_slots;

ALTER TABLE public.servers DROP COLUMN IF EXISTS steam_account_token;
