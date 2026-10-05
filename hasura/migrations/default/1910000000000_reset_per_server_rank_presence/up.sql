-- Presence used to store a snapshot of the *global* ladder. Per-server ranks
-- now accumulate independently; clear the polluted totals so each box rebuilds.
TRUNCATE TABLE public.public_server_rank_presence;
