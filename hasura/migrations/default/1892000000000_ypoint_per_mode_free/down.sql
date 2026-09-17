DELETE FROM public.settings
WHERE name IN (
  'public.ypoint_free_duel',
  'public.ypoint_free_wingman',
  'public.ypoint_free_trios'
);
