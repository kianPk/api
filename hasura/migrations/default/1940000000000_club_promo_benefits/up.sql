ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS promo_text text,
  ADD COLUMN IF NOT EXISTS join_benefits text;

COMMENT ON COLUMN public.clubs.promo_text IS
  'Optional club advertisement / promo copy shown on the club page';
COMMENT ON COLUMN public.clubs.join_benefits IS
  'Optional list of join benefits shown on the club page';
