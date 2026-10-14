-- Give everyone who already bought Premium the profile emblem for that season.
INSERT INTO public.awards (name, description, tier, silhouette, system_key, allow_multiple)
SELECT
    'Battle Pass S' || s.number,
    'Unlocked the Premium Battle Pass for season ' || s.number || '.',
    'special',
    3,
    'battle_pass_s' || s.number || '_premium',
    false
  FROM public.battle_pass_seasons s
  WHERE EXISTS (
    SELECT 1 FROM public.battle_pass_progress p
     WHERE p.season_id = s.id AND p.premium = true
  )
ON CONFLICT (system_key) DO NOTHING;

INSERT INTO public.award_recipients (award_id, player_steam_id, source, note)
SELECT a.id, p.steam_id, 'manual', 'Battle Pass season ' || s.number
  FROM public.battle_pass_progress p
  JOIN public.battle_pass_seasons s ON s.id = p.season_id
  JOIN public.awards a ON a.system_key = 'battle_pass_s' || s.number || '_premium'
 WHERE p.premium = true
   AND NOT EXISTS (
     SELECT 1 FROM public.award_recipients r
      WHERE r.award_id = a.id AND r.player_steam_id = p.steam_id
   );
