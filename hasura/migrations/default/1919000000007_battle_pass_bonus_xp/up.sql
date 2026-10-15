-- XP packs claimed from the Battle Pass track sit on top of earned XP.
ALTER TABLE public.battle_pass_progress
  ADD COLUMN IF NOT EXISTS bonus_xp integer NOT NULL DEFAULT 0
    CHECK (bonus_xp >= 0);
