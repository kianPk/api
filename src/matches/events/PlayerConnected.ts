import MatchEventProcessor from "./abstracts/MatchEventProcessor";

const LIVE_MAP_STATUSES = new Set(["Knife", "Live", "Overtime"]);

export default class PlayerConnected extends MatchEventProcessor<{
  steam_id: string;
  player_name: string;
}> {
  public async process() {
    await this.hasura.mutation({
      insert_players_one: {
        __args: {
          object: {
            name: this.data.player_name,
            steam_id: this.data.steam_id,
          },
          on_conflict: {
            constraint: "players_steam_id_key",
            update_columns: ["name"],
            // Only refill name for a player who hasn't been through
            // registerName/approveNameChange -- otherwise every connect
            // reverts a deliberately chosen, admin-approved name back to
            // whatever Steam persona the game server reports.
            //
            // name_registered is nullable with no default, so most rows are
            // NULL. A bare _eq: false would evaluate to NULL and update
            // nothing, silently ending name refresh for everyone.
            where: {
              _or: [
                { name_registered: { _is_null: true } },
                { name_registered: { _eq: false } },
              ],
            },
          },
        },
        __typename: true,
      },
    });
    // Marks them as present. Cleared again on disconnect, so this always means
    // "in the server right now" -- which is what both the force-start check and
    // the no-show penalty on cancellation read.
    await this.hasura.mutation({
      update_match_lineup_players: {
        __args: {
          where: {
            steam_id: {
              _eq: this.data.steam_id,
            },
            lineup: {
              match_id: {
                _eq: this.matchId,
              },
            },
          },
          _set: {
            is_connected: true,
          },
        },
        affected_rows: true,
      },
    });

    await this.chat.joinLobbyViaGame(this.matchId, this.data.steam_id);

    await this.clearDisconnectCancelIfLobbyFull();

    // Kick immediately if ranked AC is required and launcher is offline.
    // Fire-and-forget so connect handling isn't delayed by RCON retries.
    void this.anticheat
      .enforceConnectedPlayer(this.matchId, this.data.steam_id)
      .catch((err) =>
        this.logger.warn(
          `AC enforce on connect failed match=${this.matchId} steam=${this.data.steam_id}: ${err}`,
        ),
      );
  }

  /**
   * If everyone in the roster is back online after a mid-game disconnect fuse
   * was armed, restore the long live-match safety net timeout.
   */
  private async clearDisconnectCancelIfLobbyFull() {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: this.matchId },
        id: true,
        status: true,
        match_maps: {
          status: true,
        },
        options: {
          auto_cancellation: true,
          live_match_timeout: true,
        },
        lineup_1: {
          lineup_players: {
            steam_id: true,
            is_connected: true,
          },
        },
        lineup_2: {
          lineup_players: {
            steam_id: true,
            is_connected: true,
          },
        },
      },
    });

    if (!match || match.options?.auto_cancellation === false) {
      return;
    }

    const live = (match.match_maps ?? []).some((map) =>
      LIVE_MAP_STATUSES.has(String(map.status)),
    );
    if (!live) {
      return;
    }

    const roster = [
      ...(match.lineup_1?.lineup_players ?? []),
      ...(match.lineup_2?.lineup_players ?? []),
    ].filter((player) => player.steam_id);

    if (roster.length === 0) {
      return;
    }

    if (roster.some((player) => !player.is_connected)) {
      return;
    }

    const timeoutMinutes = Math.max(
      15,
      Number(match.options?.live_match_timeout) || 180,
    );
    const restoresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000);

    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: { id: this.matchId },
          _set: {
            cancels_at: restoresAt.toISOString(),
          },
        },
        __typename: true,
      },
    });

    this.logger.log(
      `match ${this.matchId}: all players reconnected — restore live timeout to ${restoresAt.toISOString()}`,
    );
  }
}
