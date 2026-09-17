-- Update live Ypoint prices: free Wingman, Duel 8, draft create 15
UPDATE public.settings SET value = '8'  WHERE name = 'public.ypoint_cost_duel';
UPDATE public.settings SET value = '0'  WHERE name = 'public.ypoint_cost_wingman';
UPDATE public.settings SET value = '15' WHERE name = 'public.ypoint_cost_draft_create';
