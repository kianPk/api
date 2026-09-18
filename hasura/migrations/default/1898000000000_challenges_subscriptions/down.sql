DROP TABLE IF EXISTS public.challenge_assignments;
DROP TABLE IF EXISTS public.player_subscriptions;
ALTER TABLE public.store_products DROP CONSTRAINT IF EXISTS store_products_subscription_tier_check;
ALTER TABLE public.store_products DROP COLUMN IF EXISTS subscription_tier;
