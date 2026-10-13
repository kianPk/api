import { DuelsService } from "./duels.service";

const FROM = "76561198000000001";
const TO = "76561198000000002";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    from_steam_id: FROM,
    to_steam_id: TO,
    status: "Matched",
    best_of: 1,
    map_id: null,
    proposed_scheduled_at: null,
    match_id: "m1",
    expires_at: new Date().toISOString(),
    wager_ypoints: 100,
    canceled_late: false,
    canceled_by_steam_id: null,
    match_outcome: null,
    match_winner_steam_id: null,
    from_no_show: null,
    to_no_show: null,
    wager_cancel_seen_at: null,
    match_status: "Live",
    live_winner_steam_id: null,
    live_from_no_show: false,
    live_to_no_show: false,
    ...overrides,
  } as Parameters<typeof DuelsService.resolveOutcome>[0];
}

describe("DuelsService.payouts", () => {
  const request = { from_steam_id: FROM, to_steam_id: TO, wager_ypoints: 100 };

  it("pays the winner both stakes less the rake", () => {
    const payouts = DuelsService.payouts(request, TO, 5);
    expect(payouts.get(TO)).toBe(190);
    expect(payouts.get(FROM)).toBe(0);
  });

  it("refunds both players without a winner", () => {
    const payouts = DuelsService.payouts(request, null, 5);
    expect(payouts.get(TO)).toBe(100);
    expect(payouts.get(FROM)).toBe(100);
  });
});

describe("DuelsService.resolveOutcome", () => {
  it("waits while the match is being played", () => {
    expect(DuelsService.resolveOutcome(row())).toEqual({ action: "wait" });
  });

  it("pays the player whose lineup won", () => {
    expect(
      DuelsService.resolveOutcome(
        row({ match_status: "Finished", live_winner_steam_id: FROM }),
      ),
    ).toEqual({ action: "pay", winnerTeamId: FROM });
  });

  it("pays the opponent of a player who bailed", () => {
    expect(
      DuelsService.resolveOutcome(
        row({
          status: "Cancelled",
          canceled_late: true,
          canceled_by_steam_id: FROM,
          match_status: "Canceled",
        }),
      ),
    ).toEqual({ action: "pay", winnerTeamId: TO });
  });

  it("pays the player who showed up when the other didn't", () => {
    expect(
      DuelsService.resolveOutcome(
        row({ match_status: "Canceled", live_to_no_show: true }),
      ),
    ).toEqual({ action: "pay", winnerTeamId: FROM });
  });

  it("uses the snapshot once the match is gone", () => {
    expect(
      DuelsService.resolveOutcome(
        row({
          status: "Cancelled",
          match_id: null,
          match_status: null,
          match_outcome: "Finished",
          match_winner_steam_id: TO,
        }),
      ),
    ).toEqual({ action: "pay", winnerTeamId: TO });
  });

  it("refunds a canceled match nobody turned up to", () => {
    expect(
      DuelsService.resolveOutcome(
        row({
          match_status: "Canceled",
          live_from_no_show: true,
          live_to_no_show: true,
        }),
      ),
    ).toEqual({ action: "refund" });
  });
});
