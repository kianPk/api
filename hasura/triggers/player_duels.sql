DROP TRIGGER IF EXISTS tbi_player_duel_listings_stamp ON public.player_duel_listings;
CREATE TRIGGER tbi_player_duel_listings_stamp
    BEFORE INSERT ON public.player_duel_listings
    FOR EACH ROW EXECUTE FUNCTION public.tbi_stamp_session_steam_id('steam_id');

-- A 1v1's match can be deleted (by an administrator, or the canceled-match GC)
-- while its Ypoint wager is still unsettled, so the outcome is frozen onto the
-- request first: the match_id FK is SET NULL on delete.
CREATE OR REPLACE FUNCTION public.tbd_match_snapshot_duel()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE player_duel_requests r
       SET status = CASE WHEN r.status = 'Matched' THEN 'Cancelled' ELSE r.status END,
           responded_at = COALESCE(r.responded_at, now()),
           match_outcome = OLD.status,
           match_winner_steam_id = (
               SELECT mlp.steam_id
                 FROM match_lineup_players mlp
                WHERE mlp.match_lineup_id = OLD.winning_lineup_id
                ORDER BY mlp.steam_id
                LIMIT 1
           ),
           from_no_show = EXISTS (
               SELECT 1 FROM abandoned_matches am
                WHERE am.match_id = OLD.id AND am.steam_id = r.from_steam_id
           ),
           to_no_show = EXISTS (
               SELECT 1 FROM abandoned_matches am
                WHERE am.match_id = OLD.id AND am.steam_id = r.to_steam_id
           )
     WHERE r.match_id = OLD.id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_match_snapshot_duel ON public.matches;
CREATE TRIGGER tbd_match_snapshot_duel
    BEFORE DELETE ON public.matches
    FOR EACH ROW
    EXECUTE FUNCTION public.tbd_match_snapshot_duel();
