-- Per-mode free flags for ranked play (replaces global ypoint_ranked_free)
INSERT INTO public.settings (name, value) VALUES
  ('public.ypoint_free_duel', 'false'),
  ('public.ypoint_free_wingman', 'false'),
  ('public.ypoint_free_trios', 'false')
ON CONFLICT (name) DO NOTHING;

-- If the old global switch was on, free all ranked modes once
UPDATE public.settings AS target
SET value = 'true'
FROM public.settings AS src
WHERE src.name = 'public.ypoint_ranked_free'
  AND src.value IN ('true', '1')
  AND target.name IN (
    'public.ypoint_free_duel',
    'public.ypoint_free_wingman',
    'public.ypoint_free_trios'
  );
