-- When a scrim request resolves to a terminal state (cancelled, declined,
-- expired), its scheduled/pending notifications are no longer actionable, so
-- remove them entirely. The "ScrimMatchCanceled" / outcome notifications are a
-- different type and are intentionally left in place.
CREATE OR REPLACE FUNCTION public.tau_scrim_request_cleanup_notifications()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status IN ('Cancelled', 'Declined', 'Expired')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
        DELETE FROM notifications
         WHERE entity_id = NEW.id::text
           AND type IN (
               'ScrimMatchScheduled',
               'ScrimRequestReceived',
               'ScrimRequestCountered'
           );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_scrim_request_cleanup_notifications
    ON public.team_scrim_requests;
CREATE TRIGGER tau_scrim_request_cleanup_notifications
    AFTER UPDATE ON public.team_scrim_requests
    FOR EACH ROW
    EXECUTE FUNCTION public.tau_scrim_request_cleanup_notifications();

-- Deleting the hosted match cancels its scrim (the match_id FK is SET NULL on
-- delete, so we cancel here in a BEFORE DELETE while it still points). Marking
-- the request Cancelled fires the cleanup trigger above, removing the stuck
-- "Scrim Scheduled" notification regardless of how the match was deleted.
--
-- We also snapshot the reputation-relevant outcome here, because canceled
-- scrim matches are GC'd ~1 day later (RemoveCancelledMatches). Once the match
-- (and its lineups / check-in records) are gone, v_team_reputation can no
-- longer tell a no-show from a clean cancel, so freeze the terminal status and
-- each team's check-in state onto the request now. Bails are already recorded
-- on the request (canceled_late / canceled_by_team_id) and don't need this.
-- The winner is frozen too: a Ypoint wager may still be unsettled when the
-- match goes.
CREATE OR REPLACE FUNCTION public.tbd_match_cancel_scrim()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE team_scrim_requests r
       SET status = 'Cancelled',
           responded_at = now(),
           match_outcome = OLD.status,
           match_winner_team_id = (
               SELECT ml.team_id
                 FROM match_lineups ml
                WHERE ml.id = OLD.winning_lineup_id
           ),
           from_team_checked_in = EXISTS (
               SELECT 1
                 FROM match_lineup_players mlp
                 JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
                WHERE ml.id IN (OLD.lineup_1_id, OLD.lineup_2_id)
                  AND ml.team_id = r.from_team_id
                  AND mlp.checked_in = true
           ),
           to_team_checked_in = EXISTS (
               SELECT 1
                 FROM match_lineup_players mlp
                 JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
                WHERE ml.id IN (OLD.lineup_1_id, OLD.lineup_2_id)
                  AND ml.team_id = r.to_team_id
                  AND mlp.checked_in = true
           )
     WHERE r.match_id = OLD.id
       AND r.status = 'Matched';
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_match_cancel_scrim ON public.matches;
CREATE TRIGGER tbd_match_cancel_scrim
    BEFORE DELETE ON public.matches
    FOR EACH ROW
    EXECUTE FUNCTION public.tbd_match_cancel_scrim();

-- Organizers can set winning_lineup_id through Hasura; on a scrim with a
-- Ypoint wager riding on it that would let them pick who gets paid.
CREATE OR REPLACE FUNCTION public.tbu_match_scrim_wager_guard()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _role text;
BEGIN
    IF NEW.winning_lineup_id IS NOT DISTINCT FROM OLD.winning_lineup_id THEN
        RETURN NEW;
    END IF;

    _role := NULLIF(current_setting('hasura.user', true), '')::json ->> 'x-hasura-role';
    IF _role IS NULL OR _role IN ('admin', 'administrator') THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM team_scrim_requests r
          JOIN team_scrim_wager_stakes s ON s.request_id = r.id
         WHERE r.match_id = NEW.id
           AND s.settled_at IS NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'This scrim has a Ypoint wager on it: only an administrator can set the winner';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_match_scrim_wager_guard ON public.matches;
CREATE TRIGGER tbu_match_scrim_wager_guard
    BEFORE UPDATE OF winning_lineup_id ON public.matches
    FOR EACH ROW
    EXECUTE FUNCTION public.tbu_match_scrim_wager_guard();

-- A request shares its match_options row with the match it schedules and
-- outlives it, so cleanup_orphaned_match_options holds the row until the
-- request goes (it cascades away with either team).
DROP TRIGGER IF EXISTS tad_team_scrim_requests ON public.team_scrim_requests;
CREATE TRIGGER tad_team_scrim_requests
    AFTER DELETE ON public.team_scrim_requests
    FOR EACH ROW
    EXECUTE FUNCTION public.tad_cleanup_match_options();
