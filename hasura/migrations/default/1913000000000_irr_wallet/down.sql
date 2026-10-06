DROP INDEX IF EXISTS public.irr_ledger_credit_idempotent_idx;
DROP INDEX IF EXISTS public.irr_ledger_steam_idx;
DROP TABLE IF EXISTS public.irr_ledger;
ALTER TABLE public.players DROP COLUMN IF EXISTS irr_balance;
