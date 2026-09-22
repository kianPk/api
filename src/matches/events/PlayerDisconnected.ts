import MatchEventProcessor from "./abstracts/MatchEventProcessor";

const LIVE_MAP_STATUSES = new Set(["Knife", "Live", "Overtime"]);

/** After a player leaves a live map, cancel if they do not rejoin within this long. */
const DISCONNECT_CANCEL_MINUTES = 5;

export default class PlayerDisconnected extends MatchEventProcessor<{
  steam_id: string;
}> {
  public async process() {
    // Leaving during warmup has to clear this, or a lobby someone walked out of
    // still looks full: the match would be force started without them, and
    // they'd dodge the no-show penalty on cancellation.
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
            is_connected: false,
          },
        },
        affected_rows: true,
      },
    });

    await this.chat.leaveLobbyViaGame(this.matchId, this.data.steam_id);

    await this.armDisconnectCancelWindow();
  }

  /**
   * Live matches used to sit on the long `live_match_timeout` (hours) even after
   * someone left. Arm a short fuse so CancelExpiredMatches ends the match if
   * they do not reconnect in time. Warmup keeps its own short no-show window.
   */
  private async armDisconnectCancelWindow() {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: this.matchId },
        id: true,
        cancels_at: true,
        status: true,
        match_maps: {
          status: true,
        },
        options: {
          auto_cancellation: true,
        },
      },
    });

    if (!match) {
      return;
    }

    if (match.options?.auto_cancellation === false) {
      return;
    }

    // Finished / canceled / waiting states are not mid-game abandons.
    if (
      match.status === "Canceled" ||
      match.status === "Finished" ||
      match.status === "Forfeit" ||
      match.status === "Tie"
    ) {
      return;
    }

    const live = (match.match_maps ?? []).some((map) =>
      LIVE_MAP_STATUSES.has(String(map.status)),
    );
    if (!live) {
      return;
    }

    const deadline = new Date(
      Date.now() + DISCONNECT_CANCEL_MINUTES * 60 * 1000,
    );
    const existing = match.cancels_at ? new Date(match.cancels_at) : null;
    // Keep the earlier deadline so a second disconnect cannot push the fuse out.
    const next =
      existing && existing.getTime() < deadline.getTime() ? existing : deadline;

    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: { id: this.matchId },
          _set: {
            cancels_at: next.toISOString(),
          },
        },
        __typename: true,
      },
    });

    this.logger.log(
      `match ${this.matchId}: player ${this.data.steam_id} disconnected mid-game — cancel at ${next.toISOString()}`,
    );
  }
}
