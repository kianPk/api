CREATE OR REPLACE FUNCTION public.can_cancel_match(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    _match_type text;
BEGIN
    IF match.status IN ('Finished', 'Tie', 'Canceled', 'Forfeit', 'Surrendered') THEN
        RETURN false;
    END IF;

    SELECT mo.type::text
      INTO _match_type
      FROM match_options mo
      WHERE mo.id = match.match_options_id;

    -- Ranked queue modes: only site administrators may cancel.
    IF _match_type IN ('Competitive', 'Wingman', 'Trios', 'Duel', 'Premier') THEN
        RETURN hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator');
    END IF;

    IF NOT is_match_organizer(match, hasura_session) THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$$;
