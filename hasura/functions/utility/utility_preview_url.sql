-- The preview clip is served by the same Cloudflare worker as a highlight, so
-- its key lives under clips/ -- that prefix is the only one the worker's route
-- patterns match, and a new prefix would need a worker redeploy to be reachable
-- at all.
--
-- The cache-buster is preview_rendered_at, not created_at: a re-render writes
-- the same key, and the worker caches immutably for 30 days.
--
-- Without a worker the API streams the clip itself, under /utility because
-- that is a prefix the API ingress already routes.
CREATE OR REPLACE FUNCTION public.utility_lineup_preview_url(utility_lineups public.utility_lineups)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        worker_url text;
        api_domain text;
        version text;
    BEGIN
        IF utility_lineups.preview_file IS NULL THEN
            RETURN NULL;
        END IF;

        version := COALESCE(
            EXTRACT(EPOCH FROM utility_lineups.preview_rendered_at)::bigint::text,
            '0'
        );

        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NOT NULL THEN
            RETURN CONCAT(worker_url, '/', utility_lineups.preview_file, '?v=', version);
        END IF;

        SELECT value INTO api_domain
        FROM settings
        WHERE name = 'api_domain';

        IF api_domain IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(api_domain, '/utility/videos/', utility_lineups.id, '?v=', version);
    END;
$$;

CREATE OR REPLACE FUNCTION public.utility_lineup_preview_thumbnail_url(utility_lineups public.utility_lineups)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        worker_url text;
        version text;
    BEGIN
        IF utility_lineups.preview_thumbnail IS NULL THEN
            RETURN NULL;
        END IF;

        version := COALESCE(
            EXTRACT(EPOCH FROM utility_lineups.preview_rendered_at)::bigint::text,
            '0'
        );

        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(worker_url, '/', utility_lineups.preview_thumbnail, '?v=', version);
    END;
$$;
