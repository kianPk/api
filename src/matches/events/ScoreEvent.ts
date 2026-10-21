import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import { e_sides_enum, e_winning_reasons_enum } from "../../../generated";

export default class ScoreEvent extends MatchEventProcessor<{
  time: string;
  round: number;
  match_map_id: number;
  lineup_1_score: number;
  lineup_1_money: number;
  lineup_1_timeouts_available: number;
  lineup_2_score: number;
  lineup_2_money: number;
  lineup_2_timeouts_available: number;
  lineup_1_side: e_sides_enum;
  lineup_2_side: e_sides_enum;
  winning_side: e_sides_enum;
  backup_file: string;
  winning_reason: e_winning_reasons_enum;
}> {
  public async process() {
    await this.cleanupData();

    await this.hasura.mutation({
      insert_match_map_rounds_one: {
        __args: {
          object: {
            time: new Date(this.data.time),
            round: this.data.round,
            backup_file: this.data.backup_file,
            match_map_id: this.data.match_map_id,
            lineup_1_score: this.data.lineup_1_score,
            lineup_1_money: this.data.lineup_1_money,
            lineup_1_timeouts_available: this.data.lineup_1_timeouts_available,
            lineup_2_score: this.data.lineup_2_score,
            lineup_2_money: this.data.lineup_2_money,
            lineup_2_timeouts_available: this.data.lineup_2_timeouts_available,
            lineup_1_side: this.data.lineup_1_side,
            lineup_2_side: this.data.lineup_2_side,
            winning_side: this.data.winning_side,
            winning_reason: this.data.winning_reason,
          },
          on_conflict: {
            constraint: "match_rounds_match_id_round_key",
            update_columns: [
              "lineup_1_score",
              "lineup_1_money",
              "lineup_1_timeouts_available",
              "lineup_2_score",
              "lineup_2_money",
              "lineup_2_timeouts_available",
              "lineup_1_side",
              "lineup_2_side",
              "winning_side",
              "backup_file",
            ],
          },
        },
        __typename: true,
      },
    });

    void this.awardRoundWin();
  }

  private async awardRoundWin() {
    if (!this.data.winning_side) return;
    const wonFirst = this.data.winning_side === this.data.lineup_1_side;
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: this.matchId },
        lineup_1: { lineup_players: { steam_id: true } },
        lineup_2: { lineup_players: { steam_id: true } },
      },
    });
    const side = wonFirst
      ? matches_by_pk?.lineup_1?.lineup_players
      : matches_by_pk?.lineup_2?.lineup_players;
    for (const player of side ?? []) {
      if (player?.steam_id) {
        void this.siteXp.apply({
          steam_id: String(player.steam_id),
          kind: "round_win",
        });
      }
    }
  }

  private async cleanupData() {
    await this.hasura.mutation({
      delete_match_map_rounds: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_kills: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_assists: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_damages: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_flashes: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_utility: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_objectives: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_unused_utility: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
    });
  }
}
