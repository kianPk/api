CREATE OR REPLACE FUNCTION public.tai_teams() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM add_owner_to_team(NEW);
    UPDATE teams
    SET captain_steam_id = NEW.owner_steam_id
    WHERE id = NEW.id
      AND captain_steam_id IS NULL;
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_teams ON public.teams;
CREATE TRIGGER tai_teams AFTER INSERT ON public.teams FOR EACH ROW EXECUTE FUNCTION public.tai_teams();

CREATE OR REPLACE FUNCTION public.tbu_teams() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.captain_steam_id IS NOT NULL
        AND NEW.captain_steam_id IS DISTINCT FROM OLD.captain_steam_id
        AND NOT EXISTS (
            SELECT 1
            FROM team_roster tr
            WHERE tr.team_id = NEW.id
              AND tr.player_steam_id = NEW.captain_steam_id
        ) THEN
        RAISE EXCEPTION 'Team captain must be a team member' USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_teams ON public.teams;
CREATE TRIGGER tbu_teams BEFORE UPDATE ON public.teams FOR EACH ROW EXECUTE FUNCTION public.tbu_teams();

-- can_change_team_role trusts owner_steam_id, but the roster write permission
-- trusts the roster role, so a new owner is made an Admin on the roster too.
CREATE OR REPLACE FUNCTION public.tau_teams() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE team_roster
    SET role = 'Admin'
    WHERE team_id = NEW.id
      AND player_steam_id = NEW.owner_steam_id
      AND role <> 'Admin';

    -- tournament_teams copies the owner at registration. Entries still in play
    -- follow the transfer, even when the new owner already owns another entry
    -- (the one-team-per-owner rule only gates registering); a finished or
    -- cancelled tournament keeps its owner of record.
    UPDATE tournament_teams tt
    SET owner_steam_id = NEW.owner_steam_id
    FROM tournaments t
    WHERE tt.team_id = NEW.id
      AND t.id = tt.tournament_id
      AND t.status NOT IN ('Finished', 'Cancelled', 'CancelledMinTeams');

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_teams ON public.teams;
CREATE TRIGGER tau_teams AFTER UPDATE ON public.teams
    FOR EACH ROW
    WHEN (NEW.owner_steam_id IS DISTINCT FROM OLD.owner_steam_id)
    EXECUTE FUNCTION public.tau_teams();
