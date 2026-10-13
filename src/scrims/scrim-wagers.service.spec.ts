import {
  ScrimWagersService,
  WagerOutcomeRow,
  WagerStake,
} from "./scrim-wagers.service";

const FROM = "team-from";
const TO = "team-to";

function row(overrides: Partial<WagerOutcomeRow> = {}): WagerOutcomeRow {
  return {
    request_exists: true,
    status: "Matched",
    from_team_id: FROM,
    to_team_id: TO,
    canceled_late: false,
    canceled_by_team_id: null,
    match_outcome: null,
    match_winner_team_id: null,
    from_team_checked_in: null,
    to_team_checked_in: null,
    match_id: "match-1",
    match_status: "Scheduled",
    live_winner_team_id: null,
    live_from_no_show: false,
    live_to_no_show: false,
    ...overrides,
  };
}

function stakes(team: string, amounts: Array<number>, prefix: string) {
  return amounts.map<WagerStake>((amount, index) => ({
    team_id: team,
    steam_id: `${prefix}${index}`,
    amount,
  }));
}

describe("ScrimWagersService", () => {
  describe("normalizeWager", () => {
    it("treats a missing wager as none", () => {
      expect(ScrimWagersService.normalizeWager(undefined)).toBe(0);
      expect(ScrimWagersService.normalizeWager(null)).toBe(0);
      expect(ScrimWagersService.normalizeWager(0)).toBe(0);
    });

    it("rejects negative and fractional wagers", () => {
      expect(() => ScrimWagersService.normalizeWager(-5)).toThrow();
      expect(() => ScrimWagersService.normalizeWager(2.5)).toThrow();
      expect(() => ScrimWagersService.normalizeWager("abc")).toThrow();
    });
  });

  describe("splitEvenly", () => {
    it("splits exactly and hands the remainder to the first players", () => {
      expect(ScrimWagersService.splitEvenly(100, 5)).toEqual([
        20, 20, 20, 20, 20,
      ]);
      expect(ScrimWagersService.splitEvenly(102, 5)).toEqual([
        21, 21, 20, 20, 20,
      ]);
      expect(ScrimWagersService.splitEvenly(3, 5)).toEqual([1, 1, 1, 0, 0]);
    });
  });

  describe("payouts", () => {
    const pot = [
      ...stakes(FROM, [20, 20, 20, 20, 20], "f"),
      ...stakes(TO, [25, 25, 25, 25], "t"),
    ];

    it("gives the winners the pot less the rake, and the losers nothing", () => {
      const payouts = ScrimWagersService.payouts(pot, TO, 5);
      // pot 200, rake 10, 190 across four equal stakes
      expect([0, 1, 2, 3].map((i) => payouts.get(`t${i}`))).toEqual([
        48, 48, 47, 47,
      ]);
      expect([0, 1, 2, 3, 4].every((i) => payouts.get(`f${i}`) === 0)).toBe(
        true,
      );
      const total = [...payouts.values()].reduce((a, b) => a + b, 0);
      expect(total).toBe(190);
    });

    it("shares the pot in proportion to what each winner staked", () => {
      const uneven = [
        ...stakes(FROM, [21, 21, 20, 20, 20], "f"),
        ...stakes(TO, [102], "t"),
      ];
      const payouts = ScrimWagersService.payouts(uneven, FROM, 0);
      const winners = [0, 1, 2, 3, 4].map((i) => payouts.get(`f${i}`));
      expect(winners.reduce((a, b) => a + b, 0)).toBe(204);
      expect(winners[0]).toBeGreaterThanOrEqual(winners[4]);
    });

    it("refunds everyone in full without a winner", () => {
      const payouts = ScrimWagersService.payouts(pot, null, 5);
      for (const stake of pot) {
        expect(payouts.get(stake.steam_id)).toBe(stake.amount);
      }
    });
  });

  describe("resolveOutcome", () => {
    it("waits while the match is still to be played", () => {
      expect(ScrimWagersService.resolveOutcome(row())).toEqual({
        action: "wait",
      });
      expect(
        ScrimWagersService.resolveOutcome(row({ match_status: "Live" })),
      ).toEqual({ action: "wait" });
    });

    it("pays the team that won the match", () => {
      expect(
        ScrimWagersService.resolveOutcome(
          row({ match_status: "Finished", live_winner_team_id: TO }),
        ),
      ).toEqual({ action: "pay", winnerTeamId: TO });
      expect(
        ScrimWagersService.resolveOutcome(
          row({ match_status: "Forfeit", live_winner_team_id: FROM }),
        ),
      ).toEqual({ action: "pay", winnerTeamId: FROM });
    });

    it("refunds a tie", () => {
      expect(
        ScrimWagersService.resolveOutcome(row({ match_status: "Tie" })),
      ).toEqual({ action: "refund" });
    });

    it("hands the pot to the other team when one bails late", () => {
      expect(
        ScrimWagersService.resolveOutcome(
          row({
            status: "Cancelled",
            match_status: "Canceled",
            canceled_late: true,
            canceled_by_team_id: FROM,
          }),
        ),
      ).toEqual({ action: "pay", winnerTeamId: TO });
    });

    it("pays the team that showed up when only the other was a no-show", () => {
      expect(
        ScrimWagersService.resolveOutcome(
          row({ match_status: "Canceled", live_to_no_show: true }),
        ),
      ).toEqual({ action: "pay", winnerTeamId: FROM });
    });

    it("refunds a cancel where both or neither side failed to show", () => {
      expect(
        ScrimWagersService.resolveOutcome(row({ match_status: "Canceled" })),
      ).toEqual({ action: "refund" });
      expect(
        ScrimWagersService.resolveOutcome(
          row({
            match_status: "Canceled",
            live_from_no_show: true,
            live_to_no_show: true,
          }),
        ),
      ).toEqual({ action: "refund" });
    });

    it("waits on an open request that has no match yet", () => {
      expect(
        ScrimWagersService.resolveOutcome(
          row({ status: "Pending", match_id: null, match_status: null }),
        ),
      ).toEqual({ action: "wait" });
    });

    it("falls back to the snapshot once the match is deleted", () => {
      expect(
        ScrimWagersService.resolveOutcome(
          row({
            status: "Cancelled",
            match_id: null,
            match_status: null,
            match_outcome: "Finished",
            match_winner_team_id: TO,
          }),
        ),
      ).toEqual({ action: "pay", winnerTeamId: TO });
      expect(
        ScrimWagersService.resolveOutcome(
          row({
            status: "Cancelled",
            match_id: null,
            match_status: null,
            match_outcome: "Scheduled",
          }),
        ),
      ).toEqual({ action: "refund" });
    });

    it("refunds stakes whose request is gone", () => {
      expect(
        ScrimWagersService.resolveOutcome(row({ request_exists: false })),
      ).toEqual({ action: "refund" });
    });
  });
});
