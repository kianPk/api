-- Elo for Servers-section modes (duels, dm, …). Survives pod restarts so a
-- Faceit-style level on TAB stays where the player left it.
CREATE TABLE IF NOT EXISTS public.servers_section_ratings (
    mode text NOT NULL,
    steam_id bigint NOT NULL,
    rating double precision NOT NULL DEFAULT 1000,
    name text,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT servers_section_ratings_pkey PRIMARY KEY (mode, steam_id),
    CONSTRAINT servers_section_ratings_mode_check
        CHECK (mode IN ('duels', 'dm', 'bhop', '2x2', 'awp')),
    CONSTRAINT servers_section_ratings_rating_check
        CHECK (rating >= 0 AND rating <= 5000)
);

CREATE INDEX IF NOT EXISTS servers_section_ratings_mode_rating_idx
    ON public.servers_section_ratings (mode, rating DESC);
