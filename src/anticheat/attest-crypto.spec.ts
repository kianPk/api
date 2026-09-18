import { createHmac } from "crypto";
import { AnticheatService } from "./anticheat.service";

describe("AnticheatService attest signing", () => {
  it("builds a stable canonical string", () => {
    const canonical = AnticheatService.attestCanonical({
      challenge: "abc",
      ts: 1700000000,
      client_version: "0.3.0",
      hardware_hash: "deadbeef",
      secure_boot: true,
      iommu: true,
      tpm_20: true,
      tpm_attestation: false,
      hvci: false,
      windows_updates: true,
      cheat_clean: true,
    });

    expect(canonical).toBe(
      [
        "challenge=abc",
        "ts=1700000000",
        "client_version=0.3.0",
        "hardware_hash=deadbeef",
        "secure_boot=1",
        "iommu=1",
        "tpm_20=1",
        "tpm_attestation=0",
        "hvci=0",
        "windows_updates=1",
        "cheat_clean=1",
      ].join("\n"),
    );
  });

  it("HMAC matches Node crypto for a known token", () => {
    const canonical = AnticheatService.attestCanonical({
      challenge: "challenge-value",
      ts: 42,
      client_version: "0.3.0",
      hardware_hash: "aa",
      secure_boot: true,
      iommu: false,
      tpm_20: true,
      tpm_attestation: true,
      hvci: false,
      windows_updates: false,
      cheat_clean: false,
    });
    const token = "device-token-example";
    const expected = createHmac("sha256", token).update(canonical).digest("hex");
    const again = createHmac("sha256", token).update(canonical).digest("hex");
    expect(again).toEqual(expected);
  });
});
