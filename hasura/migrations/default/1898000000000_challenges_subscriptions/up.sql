-- Site Premium / Premium Plus subscriptions + daily challenges

ALTER TABLE public.store_products
  ADD COLUMN IF NOT EXISTS subscription_tier text;

ALTER TABLE public.store_products
  DROP CONSTRAINT IF EXISTS store_products_subscription_tier_check;

ALTER TABLE public.store_products
  ADD CONSTRAINT store_products_subscription_tier_check
  CHECK (
    subscription_tier IS NULL
    OR subscription_tier IN ('premium', 'premium_plus')
  );

COMMENT ON COLUMN public.store_products.subscription_tier IS
  'Site subscription that unlocks Challenges: premium | premium_plus';

CREATE TABLE IF NOT EXISTS public.player_subscriptions (
  steam_id bigint PRIMARY KEY REFERENCES public.players (steam_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('premium', 'premium_plus')),
  expires_at timestamptz,
  order_id uuid REFERENCES public.store_orders (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS player_subscriptions_active_idx
  ON public.player_subscriptions (tier, expires_at);

COMMENT ON TABLE public.player_subscriptions IS
  'Active site Premium / Premium Plus entitlement for Challenges';

CREATE TABLE IF NOT EXISTS public.challenge_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id bigint NOT NULL REFERENCES public.players (steam_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  day_date date NOT NULL,
  challenge_key text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('premium', 'premium_plus')),
  target integer NOT NULL CHECK (target > 0),
  progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
  reward_ypoints integer NOT NULL CHECK (reward_ypoints >= 0),
  completed_at timestamptz,
  rewarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT challenge_assignments_unique
    UNIQUE (steam_id, day_date, challenge_key)
);

CREATE INDEX IF NOT EXISTS challenge_assignments_day_idx
  ON public.challenge_assignments (steam_id, day_date);

-- Seed catalog products (admin can edit price later). Prices in IRR.
INSERT INTO public.store_products (
  title, slug, description, price_irr, active, sort_order,
  subscription_tier, vip_duration, ypoint_amount
) VALUES
  (
    'Premium',
    'premium-30d',
    'Unlock daily Challenges for 30 days. Two Premium challenges every day with Ypoint rewards.',
    1490000,
    true,
    10,
    'premium',
    '30d',
    NULL
  ),
  (
    'Premium Plus',
    'premium-plus-30d',
    'Unlock Premium Plus Challenges for 30 days. Harder daily goals and bigger Ypoint rewards.',
    2990000,
    true,
    11,
    'premium_plus',
    '30d',
    NULL
  )
ON CONFLICT (slug) DO UPDATE SET
  subscription_tier = EXCLUDED.subscription_tier,
  vip_duration = COALESCE(store_products.vip_duration, EXCLUDED.vip_duration),
  active = true,
  updated_at = now();
