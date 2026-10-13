ALTER TABLE public.team_scrim_requests
    ADD COLUMN IF NOT EXISTS wager_ypoints integer NOT NULL DEFAULT 0
        CHECK (wager_ypoints >= 0),
    ADD COLUMN IF NOT EXISTS wager_rake_percent integer,
    ADD COLUMN IF NOT EXISTS wager_status text
        CHECK (wager_status IN ('Escrowed', 'Paid', 'Refunded')),
    ADD COLUMN IF NOT EXISTS wager_winner_team_id uuid
        REFERENCES public.teams (id) ON UPDATE cascade ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS wager_settled_at timestamptz,
    ADD COLUMN IF NOT EXISTS wager_cancel_seen_at timestamptz,
    ADD COLUMN IF NOT EXISTS match_winner_team_id uuid;

-- No foreign keys on purpose: a request cascades away with either team, and
-- the stakes have to outlive it so the escrow can still be refunded.
CREATE TABLE IF NOT EXISTS public.team_scrim_wager_stakes (
    request_id uuid NOT NULL,
    team_id uuid NOT NULL,
    steam_id bigint NOT NULL,
    amount integer NOT NULL CHECK (amount > 0),
    payout integer,
    settled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (request_id, steam_id)
);

CREATE INDEX IF NOT EXISTS team_scrim_wager_stakes_unsettled_idx
    ON public.team_scrim_wager_stakes (request_id)
    WHERE settled_at IS NULL;
