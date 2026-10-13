CREATE TABLE IF NOT EXISTS public.player_duel_listings (
    steam_id bigint NOT NULL PRIMARY KEY REFERENCES public.players (steam_id) ON UPDATE cascade ON DELETE cascade,
    note text CHECK (note IS NULL OR char_length(note) <= 140),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.player_duel_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    from_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE cascade ON DELETE cascade,
    to_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE cascade ON DELETE cascade,
    status text NOT NULL DEFAULT 'Pending' REFERENCES public.e_scrim_request_statuses (value) ON UPDATE cascade ON DELETE restrict,
    best_of integer NOT NULL DEFAULT 1 CHECK (best_of IN (1, 3, 5)),
    map_id uuid REFERENCES public.maps (id) ON UPDATE cascade ON DELETE SET NULL,
    -- NULL: play as soon as it is accepted
    proposed_scheduled_at timestamptz,
    match_id uuid REFERENCES public.matches (id) ON UPDATE cascade ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    canceled_late boolean NOT NULL DEFAULT false,
    canceled_by_steam_id bigint,
    match_outcome text,
    match_winner_steam_id bigint,
    from_no_show boolean,
    to_no_show boolean,
    wager_ypoints integer NOT NULL DEFAULT 0 CHECK (wager_ypoints >= 0),
    wager_rake_percent integer,
    wager_status text CHECK (wager_status IN ('Escrowed', 'Paid', 'Refunded')),
    wager_winner_steam_id bigint,
    wager_settled_at timestamptz,
    wager_cancel_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    responded_at timestamptz,
    CHECK (from_steam_id <> to_steam_id)
);

CREATE INDEX IF NOT EXISTS idx_player_duel_requests_from_status
    ON public.player_duel_requests (from_steam_id, status);
CREATE INDEX IF NOT EXISTS idx_player_duel_requests_to_status
    ON public.player_duel_requests (to_steam_id, status);
CREATE INDEX IF NOT EXISTS idx_player_duel_requests_escrowed
    ON public.player_duel_requests (id) WHERE wager_status = 'Escrowed';
CREATE UNIQUE INDEX IF NOT EXISTS uq_duel_req_open
    ON public.player_duel_requests (
        LEAST(from_steam_id, to_steam_id),
        GREATEST(from_steam_id, to_steam_id)
    )
    WHERE status = 'Pending';
