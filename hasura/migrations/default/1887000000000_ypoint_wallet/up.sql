-- Ypoint wallet + ledger + store pack amounts + fee settings

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS ypoint_balance integer NOT NULL DEFAULT 0
  CHECK (ypoint_balance >= 0);

CREATE TABLE IF NOT EXISTS public.ypoint_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  delta integer NOT NULL,
  balance_after integer NOT NULL,
  reason text NOT NULL,
  ref_type text,
  ref_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ypoint_ledger_steam_idx
  ON public.ypoint_ledger (steam_id, created_at DESC);

ALTER TABLE public.store_products
  ADD COLUMN IF NOT EXISTS ypoint_amount integer
  CHECK (ypoint_amount IS NULL OR ypoint_amount > 0);

COMMENT ON COLUMN public.players.ypoint_balance IS 'YGuard Ypoint balance (paid shop currency)';
COMMENT ON COLUMN public.store_products.ypoint_amount IS 'If set, paying for this product credits this many Ypoints';
COMMENT ON TABLE public.ypoint_ledger IS 'Append-only Ypoint balance changes';

INSERT INTO public.settings (name, value) VALUES
  ('public.ypoint_cost_duel', '8'),
  ('public.ypoint_cost_wingman', '0'),
  ('public.ypoint_cost_draft_create', '15'),
  ('public.ypoint_cost_draft_join', '10')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.store_products
  (title, slug, description, price_irr, ypoint_amount, sort_order, active)
VALUES
  ('50 Ypoints', 'ypoint-50', 'Credit 50 Ypoints to your wallet.', 50000, 50, 10, true),
  ('100 Ypoints', 'ypoint-100', 'Credit 100 Ypoints to your wallet.', 90000, 100, 20, true),
  ('250 Ypoints', 'ypoint-250', 'Credit 250 Ypoints to your wallet.', 200000, 250, 30, true),
  ('500 Ypoints', 'ypoint-500', 'Credit 500 Ypoints to your wallet.', 350000, 500, 40, true)
ON CONFLICT (slug) DO NOTHING;
