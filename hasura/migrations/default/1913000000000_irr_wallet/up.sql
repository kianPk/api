-- Toman (IRR) site wallet for players. Stored in Rials (1 Toman = 10 Rials).
-- Used for hosted VIP shop earnings paid via Bale.

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS irr_balance bigint NOT NULL DEFAULT 0
  CHECK (irr_balance >= 0);

CREATE TABLE IF NOT EXISTS public.irr_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  delta bigint NOT NULL,
  balance_after bigint NOT NULL,
  reason text NOT NULL,
  ref_type text,
  ref_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS irr_ledger_steam_idx
  ON public.irr_ledger (steam_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS irr_ledger_credit_idempotent_idx
  ON public.irr_ledger (steam_id, ref_type, ref_id)
  WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL AND delta > 0;

COMMENT ON COLUMN public.players.irr_balance IS
  'Site Toman wallet balance in Rials (IRR). UI shows Tomans (÷10).';
COMMENT ON TABLE public.irr_ledger IS
  'Append-only IRR (Rials) balance changes';

-- Hosted VIP prices are now Toman via Bale (stored as Rials), not Ypoints.
COMMENT ON COLUMN public.hosted_servers.vip_price_7d IS
  'IRR (Rials) price for 7-day VIP via Bale (0 = not offered). UI = Tomans.';
COMMENT ON COLUMN public.hosted_servers.vip_price_30d IS
  'IRR (Rials) price for 30-day VIP via Bale (0 = not offered). UI = Tomans.';
COMMENT ON COLUMN public.hosted_servers.vip_price_90d IS
  'IRR (Rials) price for 90-day VIP via Bale (0 = not offered). UI = Tomans.';
