import {
  DAILY_MISSIONS,
  levelForXp,
  MATCH_XP_DAILY_CAP,
  MAX_LEVEL,
  matchXp,
  missionProgress,
  pickMissions,
  rewardFor,
  SeasonMatch,
  weekStart,
  WEEKLY_MISSIONS,
} from "./battle-pass-catalog";

function match(overrides: Partial<SeasonMatch> = {}): SeasonMatch {
  return {
    match_id: "m",
    type: "Competitive",
    day: "2026-10-13",
    won: false,
    rounds_played: 20,
    kills: 0,
    hs_kills: 0,
    damage: 0,
    assists: 0,
    enemies_flashed: 0,
    he_damage: 0,
    three_kill_rounds: 0,
    trade_kill_successes: 0,
    ...overrides,
  };
}

describe("battle pass catalog", () => {
  it("levels up every 1000 XP and caps at the max level", () => {
    expect(levelForXp(0)).toBe(0);
    expect(levelForXp(999)).toBe(0);
    expect(levelForXp(1000)).toBe(1);
    expect(levelForXp(10_000_000)).toBe(MAX_LEVEL);
  });

  it("has a premium reward on every level and badges at the top", () => {
    for (let level = 1; level <= MAX_LEVEL; level++) {
      expect(rewardFor(level, "premium")).not.toBeNull();
    }
    expect(rewardFor(50, "premium")).toEqual({
      type: "badge",
      badge: "legend",
    });
    expect(rewardFor(50, "free")).toEqual({ type: "badge", badge: "elite" });
    expect(rewardFor(25, "free")).toEqual({ type: "badge", badge: "veteran" });
    expect(rewardFor(3, "free")).toBeNull();
    expect(rewardFor(0, "premium")).toBeNull();
    expect(rewardFor(MAX_LEVEL + 1, "premium")).toBeNull();
  });

  it("caps match XP per day and skips matches with almost no rounds", () => {
    const day = Array.from({ length: MATCH_XP_DAILY_CAP + 3 }, () =>
      match({ won: true }),
    );
    expect(matchXp(day)).toBe(MATCH_XP_DAILY_CAP * 150);
    expect(matchXp([match({ rounds_played: 1 })])).toBe(0);
    expect(matchXp([match(), match({ day: "2026-10-14", won: true })])).toBe(
      250,
    );
  });

  it("measures mission progress by kind and mode", () => {
    const games = [
      match({ kills: 10, won: true, three_kill_rounds: 1 }),
      match({ kills: 7, type: "Duel", three_kill_rounds: 2 }),
    ];
    expect(
      missionProgress({ key: "a", xp: 1, target: 1, kind: "play" }, games),
    ).toBe(2);
    expect(
      missionProgress({ key: "b", xp: 1, target: 1, kind: "win" }, games),
    ).toBe(1);
    expect(
      missionProgress(
        { key: "c", xp: 1, target: 1, kind: "sum", stat: "kills" },
        games,
      ),
    ).toBe(17);
    expect(
      missionProgress(
        { key: "d", xp: 1, target: 1, kind: "best", stat: "three_kill_rounds" },
        games,
      ),
    ).toBe(2);
    expect(
      missionProgress(
        { key: "e", xp: 1, target: 1, kind: "play", matchType: "Duel" },
        games,
      ),
    ).toBe(1);
  });

  it("picks a stable, distinct set of missions per seed", () => {
    const first = pickMissions(DAILY_MISSIONS, "1|2026-10-13|daily", 3);
    const again = pickMissions(DAILY_MISSIONS, "1|2026-10-13|daily", 3);
    expect(first.map((m) => m.key)).toEqual(again.map((m) => m.key));
    expect(new Set(first.map((m) => m.key)).size).toBe(3);
    expect(pickMissions(WEEKLY_MISSIONS, "seed", 99)).toHaveLength(
      WEEKLY_MISSIONS.length,
    );
  });

  it("starts weeks on Saturday", () => {
    expect(weekStart("2026-10-10")).toBe("2026-10-10");
    expect(weekStart("2026-10-13")).toBe("2026-10-10");
    expect(weekStart("2026-10-16")).toBe("2026-10-10");
    expect(weekStart("2026-10-17")).toBe("2026-10-17");
  });
});
