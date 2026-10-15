-- Servers → Host: timed rentals that boot as a section mode (duels/dm/bhop/2x2/awp).

ALTER TABLE public.store_products
  ADD COLUMN IF NOT EXISTS hosted_section_mode text
  CHECK (
    hosted_section_mode IS NULL
    OR hosted_section_mode IN ('any', 'duels', 'dm', 'bhop', '2x2', 'awp')
  );

COMMENT ON COLUMN public.store_products.hosted_section_mode IS
  'With hosted_slots: Servers Host rental plan. any = buyer picks the mode at checkout.';

ALTER TABLE public.store_orders
  ADD COLUMN IF NOT EXISTS hosted_section_mode text
  CHECK (
    hosted_section_mode IS NULL
    OR hosted_section_mode IN ('duels', 'dm', 'bhop', '2x2', 'awp')
  );

ALTER TABLE public.hosted_servers
  ADD COLUMN IF NOT EXISTS section_mode text
  CHECK (
    section_mode IS NULL
    OR section_mode IN ('duels', 'dm', 'bhop', '2x2', 'awp')
  );

COMMENT ON COLUMN public.hosted_servers.section_mode IS
  'When set, this rental boots as a Servers-section mode rather than a classic hosted type.';

ALTER TABLE public.servers
  ADD COLUMN IF NOT EXISTS hosted_section boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.servers.hosted_section IS
  'Paid Host rental with section_mode — excluded from the public fleet and section reconcile.';

-- Duration plans: buyer picks Duels / DM / BHOP / 2x2 / AWP at checkout.
-- hosted_slots is a ceiling; provision uses the mode's max_players.
INSERT INTO public.store_products (
  slug, title, description, price_irr, price_ypoint, hosted_slots,
  vip_duration, hosted_section_mode, sort_order, active
) VALUES
  (
    'host-section-1h',
    'Host — 1 hour',
    'Rent a private Servers-mode server for 1 hour. Pick Duels, Deathmatch, BHOP, 2x2 or AWP.',
    500000, 50, 20, '1h', 'any', 200, true
  ),
  (
    'host-section-3h',
    'Host — 3 hours',
    'Rent a private Servers-mode server for 3 hours. Pick Duels, Deathmatch, BHOP, 2x2 or AWP.',
    1200000, 120, 20, '3h', 'any', 201, true
  ),
  (
    'host-section-12h',
    'Host — 12 hours',
    'Rent a private Servers-mode server for 12 hours. Pick Duels, Deathmatch, BHOP, 2x2 or AWP.',
    3500000, 350, 20, '12h', 'any', 202, true
  ),
  (
    'host-section-1d',
    'Host — 1 day',
    'Rent a private Servers-mode server for 1 day. Pick Duels, Deathmatch, BHOP, 2x2 or AWP.',
    6000000, 600, 20, '1d', 'any', 203, true
  ),
  (
    'host-section-3d',
    'Host — 3 days',
    'Rent a private Servers-mode server for 3 days. Pick Duels, Deathmatch, BHOP, 2x2 or AWP.',
    15000000, 1500, 20, '3d', 'any', 204, true
  ),
  (
    'host-section-7d',
    'Host — 7 days',
    'Rent a private Servers-mode server for 7 days. Pick Duels, Deathmatch, BHOP, 2x2 or AWP.',
    30000000, 3000, 20, '7d', 'any', 205, true
  )
ON CONFLICT (slug) DO NOTHING;
