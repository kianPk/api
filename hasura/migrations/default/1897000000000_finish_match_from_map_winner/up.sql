-- Ranked Competitive matches were stuck Live / later Canceled when the plugin
-- finished a map with winning_lineup_id but round score rows were missing
-- (lineup_*_score → 0-0). Elo and Watch both require matches.status=Finished
-- with a winner, so those matches vanished as if never played.
--
-- Honor match_maps.winning_lineup_id when round scores are tied/absent, and
-- never invent a winner when both sides have zero map wins.

CREATE OR REPLACE FUNCTION public.update_match_state(_match_map match_maps) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    maps_won INT := 0;
    match_best_of INT;
    map_lineup_1_score INT;
    map_lineup_2_score INT;
    match_lineup_1_id UUID;
    match_lineup_2_id UUID;
    current_match_status TEXT;
    match_winning_lineup_id UUID;
    lineup_1_wins INT := 0;
    lineup_2_wins INT := 0;
    final_advantage INT := 0;
    match_map public.match_maps;
    wins_needed INT;
BEGIN
    SELECT mo.best_of, lineup_1_id, lineup_2_id
    INTO match_best_of, match_lineup_1_id, match_lineup_2_id
    FROM matches m
    INNER JOIN match_options mo
    ON mo.id = m.match_options_id
    WHERE m.id = _match_map.match_id;

    IF (_match_map.status = 'Finished') THEN
        SELECT status
        INTO current_match_status
        FROM matches
        WHERE id = _match_map.match_id;

        IF current_match_status IN ('Finished', 'Forfeit', 'Surrendered', 'Canceled', 'Tie') THEN
            RETURN;
        END IF;

        SELECT COALESCE(ts.final_map_advantage, 0)
        INTO final_advantage
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE tb.match_id = _match_map.match_id
          AND ts.type = 'DoubleElimination'
          AND tb.parent_bracket_id IS NULL
          AND COALESCE(tb.path, 'WB') = 'WB'
          AND EXISTS (
              SELECT 1
              FROM tournament_brackets lb
              WHERE lb.parent_bracket_id = tb.id
                AND lb.path = 'LB'
          );

        lineup_1_wins := LEAST(
            COALESCE(final_advantage, 0),
            CEIL(match_best_of / 2.0)::int - 1
        );

        wins_needed := CEIL(match_best_of / 2.0)::int;

        FOR match_map IN
            SELECT *
            FROM match_maps
            WHERE match_id = _match_map.match_id
              AND status = 'Finished'
        LOOP
            map_lineup_1_score := lineup_1_score(match_map);
            map_lineup_2_score := lineup_2_score(match_map);
            IF map_lineup_1_score > map_lineup_2_score THEN
                lineup_1_wins := lineup_1_wins + 1;
            ELSIF map_lineup_2_score > map_lineup_1_score THEN
                lineup_2_wins := lineup_2_wins + 1;
            ELSIF match_map.winning_lineup_id IS NOT NULL THEN
                IF match_map.winning_lineup_id = match_lineup_1_id THEN
                    lineup_1_wins := lineup_1_wins + 1;
                ELSIF match_map.winning_lineup_id = match_lineup_2_id THEN
                    lineup_2_wins := lineup_2_wins + 1;
                END IF;
            END IF;
        END LOOP;

        IF lineup_1_wins >= wins_needed THEN
            match_winning_lineup_id := match_lineup_1_id;
        ELSIF lineup_2_wins >= wins_needed THEN
            match_winning_lineup_id := match_lineup_2_id;
        ELSE
            match_winning_lineup_id := NULL;
        END IF;

        IF match_winning_lineup_id IS NOT NULL THEN
            UPDATE matches
            SET status = 'Finished', winning_lineup_id = match_winning_lineup_id
            WHERE id = _match_map.match_id;
        END IF;
    END IF;
    RETURN;
END;
$$;
