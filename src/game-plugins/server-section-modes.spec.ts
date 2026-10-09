import { SERVER_SECTION_MODES, sectionMapsFrom } from "./server-section-modes";

describe("sectionMapsFrom", () => {
  const duels = SERVER_SECTION_MODES.duels;

  it("uses the mode's defaults until an operator saves a pool", () => {
    expect(sectionMapsFrom(duels, null)).toEqual(duels.defaultMaps);
    expect(sectionMapsFrom(duels, "not json")).toEqual(duels.defaultMaps);
    expect(sectionMapsFrom(duels, "[]")).toEqual(duels.defaultMaps);
  });

  it("keeps the saved order and drops anything unsafe for the console", () => {
    const saved = JSON.stringify([
      { id: "3139172262", name: "Redline" },
      { id: "de_mirage", name: "Mirage" },
      { id: "3139172262", name: "Redline again" },
      { id: "de_dust2; quit", name: "Dust" },
      { id: "3626024193", name: 'am_map"; quit' },
      { id: "", name: "Nothing" },
    ]);

    expect(sectionMapsFrom(duels, saved)).toEqual([
      { id: "3139172262", name: "Redline" },
      { id: "de_mirage", name: "Mirage" },
      { id: "3626024193", name: "am_map quit" },
    ]);
  });
});
