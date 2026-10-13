DROP TABLE IF EXISTS public.team_scrim_wager_stakes;

ALTER TABLE public.team_scrim_requests
    DROP COLUMN IF EXISTS match_winner_team_id,
    DROP COLUMN IF EXISTS wager_cancel_seen_at,
    DROP COLUMN IF EXISTS wager_settled_at,
    DROP COLUMN IF EXISTS wager_winner_team_id,
    DROP COLUMN IF EXISTS wager_status,
    DROP COLUMN IF EXISTS wager_rake_percent,
    DROP COLUMN IF EXISTS wager_ypoints;
