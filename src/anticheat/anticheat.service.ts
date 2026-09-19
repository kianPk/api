import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { PostgresService } from "../postgres/postgres.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";

export type AcChecks = {
  secure_boot: boolean;
  iommu: boolean;
  tpm_20: boolean;
  tpm_attestation: boolean;
  hvci: boolean;
  windows_updates: boolean;
};

export type AcRequirements = AcChecks & {
  required: boolean;
  ttl_minutes: number;
};

export type AcCheatHit = {
  signature: string;
  path?: string;
  process_name?: string;
  details?: Record<string, unknown>;
};

/** Launcher must heartbeat at least this often while in a match. */
const DEVICE_ALIVE_SECONDS = 35;

/** One-time attest challenge lifetime (seconds). */
const CHALLENGE_TTL_SECONDS = 45;

/** Reject attest clocks skewed more than this (seconds). */
const ATTEST_CLOCK_SKEW_SECONDS = 300;

/** Minimum launcher build that speaks the signed-challenge protocol. */
const MIN_CLIENT_VERSION =
  process.env.AC_LAUNCHER_MIN_VERSION?.trim() || "0.3.2";

@Injectable()
export class AnticheatService implements OnModuleInit, OnModuleDestroy {
  private enforceTimer?: NodeJS.Timeout;

  constructor(
    private readonly postgres: PostgresService,
    private readonly logger: Logger,
    private readonly moduleRef: ModuleRef,
  ) {}

  public onModuleInit() {
    // Drop leftover "security requirements" platform bans — those should never
    // have looked like a site ban; queue is gated by attestation only.
    void this.liftAllSecurityBans().catch((err) =>
      this.logger.warn(`AC security-ban cleanup failed: ${err}`),
    );

    // Ensure challenge / hardware-bind columns exist even if Hasura migrate
    // was skipped on the panel — otherwise 0.3.x clients get "Connection refused".
    void this.ensureSecuritySchema().catch((err) =>
      this.logger.warn(`AC security schema ensure failed: ${err}`),
    );

    this.enforceTimer = setInterval(() => {
      void this.enforceLiveMatchAc().catch((err) =>
        this.logger.warn(`AC live enforce failed: ${err}`),
      );
    }, 5_000);
  }

  public onModuleDestroy() {
    if (this.enforceTimer) clearInterval(this.enforceTimer);
  }

  /** Idempotent DDL so signed-attest works without a manual migrate step. */
  private async ensureSecuritySchema(): Promise<void> {
    await this.postgres.query(`
      ALTER TABLE public.ac_devices
        ADD COLUMN IF NOT EXISTS hardware_hash text,
        ADD COLUMN IF NOT EXISTS client_version text
    `);
    await this.postgres.query(`
      CREATE TABLE IF NOT EXISTS public.ac_challenges (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id uuid NOT NULL REFERENCES public.ac_devices(id) ON DELETE CASCADE,
        challenge_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.postgres.query(`
      CREATE INDEX IF NOT EXISTS ac_challenges_device_idx
        ON public.ac_challenges (device_id, expires_at DESC)
    `);

    // Heal devices false-revoked by unstable HW fingerprints so players can
    // queue again without re-pairing as soon as this API rolls out.
    const healed = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.ac_devices
       SET revoked_at = NULL
       WHERE revoked_at IS NOT NULL
       RETURNING id::text`,
    );
    if (healed.length > 0) {
      this.logger.warn(`AC healed ${healed.length} revoked device(s)`);
    }

    this.logger.log("AC security schema ready (challenges + hardware bind)");
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private hashChallenge(challenge: string): string {
    return createHash("sha256").update(challenge).digest("hex");
  }

  private parseVersion(raw: string): number[] {
    return String(raw || "")
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((p) => Number.parseInt(p.replace(/\D.*/, ""), 10) || 0)
      .concat([0, 0, 0])
      .slice(0, 3);
  }

  private isVersionAtLeast(actual: string, minimum: string): boolean {
    const a = this.parseVersion(actual);
    const m = this.parseVersion(minimum);
    for (let i = 0; i < 3; i++) {
      if (a[i] > m[i]) return true;
      if (a[i] < m[i]) return false;
    }
    return true;
  }

  private timingSafeHexEqual(a: string, b: string): boolean {
    try {
      const ba = Buffer.from(String(a || ""), "hex");
      const bb = Buffer.from(String(b || ""), "hex");
      if (ba.length === 0 || ba.length !== bb.length) return false;
      return timingSafeEqual(ba, bb);
    } catch {
      return false;
    }
  }

  /**
   * Canonical string the launcher HMAC-signs. Field order is fixed so
   * crackers cannot reorder JSON and still pass.
   */
  public static attestCanonical(input: {
    challenge: string;
    ts: number;
    client_version: string;
    hardware_hash: string;
    secure_boot: boolean;
    iommu: boolean;
    tpm_20: boolean;
    tpm_attestation: boolean;
    hvci: boolean;
    windows_updates: boolean;
    cheat_clean: boolean;
  }): string {
    const flag = (v: boolean) => (v ? "1" : "0");
    return [
      `challenge=${input.challenge}`,
      `ts=${input.ts}`,
      `client_version=${input.client_version}`,
      `hardware_hash=${input.hardware_hash}`,
      `secure_boot=${flag(input.secure_boot)}`,
      `iommu=${flag(input.iommu)}`,
      `tpm_20=${flag(input.tpm_20)}`,
      `tpm_attestation=${flag(input.tpm_attestation)}`,
      `hvci=${flag(input.hvci)}`,
      `windows_updates=${flag(input.windows_updates)}`,
      `cheat_clean=${flag(input.cheat_clean)}`,
    ].join("\n");
  }

  private signAttest(deviceToken: string, canonical: string): string {
    return createHmac("sha256", deviceToken).update(canonical).digest("hex");
  }

  private async settingFlag(name: string, fallback = false): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [name],
    );
    const raw = rows.at(0)?.value;
    if (raw === undefined || raw === null || raw === "") return fallback;
    return raw === "true" || raw === "1";
  }

  private async settingNumber(name: string, fallback: number): Promise<number> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [name],
    );
    const raw = rows.at(0)?.value;
    if (raw === undefined || raw === null || raw === "") return fallback;
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
  }

  public async getRequirements(): Promise<AcRequirements> {
    const [
      required,
      ttl,
      secure_boot,
      tpm_20,
      hvci,
      iommu,
      windows_updates,
    ] = await Promise.all([
      this.settingFlag(SystemSettingName.AcLauncherRequired, false),
      this.settingNumber(SystemSettingName.AcAttestationTtlMinutes, 2),
      this.settingFlag(SystemSettingName.AcRequireSecureBoot, true),
      this.settingFlag(SystemSettingName.AcRequireTpm, true),
      this.settingFlag(SystemSettingName.AcRequireHvci, false),
      this.settingFlag(SystemSettingName.AcRequireIommu, false),
      this.settingFlag(SystemSettingName.AcRequireWindowsUpdates, false),
    ]);

    return {
      required,
      // Short TTL so closing the launcher drops ranked access quickly.
      // Launcher heartbeats ~30s; clamp 2–30 minutes.
      ttl_minutes: Math.max(2, Math.min(30, ttl)),
      secure_boot,
      iommu,
      tpm_20,
      // Soft-tied to TPM for MVP; real TPM quote comes later.
      tpm_attestation: tpm_20,
      hvci,
      windows_updates,
    };
  }

  /** Launcher starts login: opens browser; no Steam yet. */
  public async beginLauncherLogin(): Promise<{
    code: string;
    verification_uri: string;
    expires_at: string;
    interval: number;
  }> {
    const code = randomBytes(3).toString("hex").toUpperCase();
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await this.postgres.query(
      `INSERT INTO public.ac_pair_codes (code, steam_id, expires_at)
       VALUES ($1, NULL, $2)`,
      [code, expires.toISOString()],
    );
    const webHost = process.env.WEB_DOMAIN || "yguard.ir";
    const base = webHost.startsWith("http") ? webHost : `https://${webHost}`;
    return {
      code,
      verification_uri: `${base.replace(/\/$/, "")}/ac/authorize?code=${code}`,
      expires_at: expires.toISOString(),
      interval: 2,
    };
  }

  /** Website (Steam session): attach this login code to the logged-in player. */
  public async approveLauncherLogin(steamId: string, code: string): Promise<{ ok: true }> {
    const normalized = String(code || "").trim().toUpperCase();
    if (!/^[A-F0-9]{6}$/.test(normalized)) {
      throw new BadRequestException("Invalid code");
    }
    const rows = await this.postgres.query<
      Array<{ steam_id: string | null; expires_at: string; claimed_at: string | null }>
    >(
      `SELECT steam_id::text, expires_at::text, claimed_at::text
       FROM public.ac_pair_codes WHERE code = $1 LIMIT 1`,
      [normalized],
    );
    const row = rows.at(0);
    if (!row) throw new BadRequestException("Code not found");
    if (row.claimed_at) throw new BadRequestException("Code already used");
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new BadRequestException("Code expired");
    }
    await this.postgres.query(
      `UPDATE public.ac_pair_codes SET steam_id = $2 WHERE code = $1`,
      [normalized, steamId],
    );
    this.logger.log(`AC launcher approved code=${normalized} steam=${steamId}`);
    return { ok: true };
  }

  /**
   * Launcher polls until the website user approved the code.
   * First successful poll creates the device and returns the token once.
   */
  public async pollLauncherLogin(
    code: string,
    label?: string,
  ): Promise<
    | { status: "pending" }
    | { status: "expired" }
    | {
        status: "ready";
        device_token: string;
        steam_id: string;
      }
  > {
    const normalized = String(code || "").trim().toUpperCase();
    if (!/^[A-F0-9]{6}$/.test(normalized)) {
      throw new BadRequestException("Invalid code");
    }
    const rows = await this.postgres.query<
      Array<{ steam_id: string | null; expires_at: string; claimed_at: string | null }>
    >(
      `SELECT steam_id::text, expires_at::text, claimed_at::text
       FROM public.ac_pair_codes WHERE code = $1 LIMIT 1`,
      [normalized],
    );
    const row = rows.at(0);
    if (!row) throw new BadRequestException("Code not found");
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { status: "expired" };
    }
    if (!row.steam_id) {
      return { status: "pending" };
    }
    if (row.claimed_at) {
      // Token already issued — launcher should have it; treat as expired/used.
      return { status: "expired" };
    }

    const claimed = await this.claimPairing(normalized, label);
    return {
      status: "ready",
      device_token: claimed.device_token,
      steam_id: claimed.steam_id,
    };
  }

  /** Logged-in web user starts pairing a launcher device (manual code). */
  public async startPairing(steamId: string): Promise<{ code: string; expires_at: string }> {
    const code = randomBytes(3).toString("hex").toUpperCase(); // 6 hex chars
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await this.postgres.query(
      `INSERT INTO public.ac_pair_codes (code, steam_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE
         SET steam_id = EXCLUDED.steam_id,
             expires_at = EXCLUDED.expires_at,
             claimed_at = NULL,
             device_token_hash = NULL`,
      [code, steamId, expires.toISOString()],
    );
    return { code, expires_at: expires.toISOString() };
  }

  /** Launcher claims a pair code and receives a device token (shown once). */
  public async claimPairing(code: string, label?: string): Promise<{
    device_token: string;
    steam_id: string;
    expires_in_days: number;
  }> {
    const normalized = String(code || "").trim().toUpperCase();
    if (!/^[A-F0-9]{6}$/.test(normalized)) {
      throw new BadRequestException("Invalid pair code");
    }

    const rows = await this.postgres.query<
      Array<{ steam_id: string; expires_at: string; claimed_at: string | null }>
    >(
      `SELECT steam_id::text, expires_at::text, claimed_at::text
       FROM public.ac_pair_codes
       WHERE code = $1
       LIMIT 1`,
      [normalized],
    );
    const row = rows.at(0);
    if (!row?.steam_id) {
      throw new BadRequestException("Pair code not found");
    }
    if (row.claimed_at) {
      throw new BadRequestException("Pair code already used");
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new BadRequestException("Pair code expired");
    }

    const deviceToken = randomBytes(32).toString("base64url");
    const tokenHash = this.hashToken(deviceToken);

    const inserted = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.ac_devices (steam_id, device_token_hash, label)
       VALUES ($1, $2, $3)
       RETURNING id::text`,
      [row.steam_id, tokenHash, (label || "YGuard AC").slice(0, 64)],
    );

    await this.postgres.query(
      `UPDATE public.ac_pair_codes
       SET claimed_at = now(), device_token_hash = $2
       WHERE code = $1`,
      [normalized, tokenHash],
    );

    this.logger.log(
      `AC device paired steam=${row.steam_id} device=${inserted.at(0)?.id}`,
    );

    return {
      device_token: deviceToken,
      steam_id: row.steam_id,
      expires_in_days: 365,
    };
  }

  private async resolveDevice(deviceToken: string): Promise<{
    id: string;
    steam_id: string;
    hardware_hash: string | null;
  }> {
    if (!deviceToken?.trim()) {
      throw new UnauthorizedException("Device token required");
    }
    const tokenHash = this.hashToken(deviceToken.trim());
    const rows = await this.postgres.query<
      Array<{
        id: string;
        steam_id: string;
        hardware_hash: string | null;
        revoked_at: string | null;
      }>
    >(
      `SELECT id::text, steam_id::text, hardware_hash, revoked_at::text
       FROM public.ac_devices
       WHERE device_token_hash = $1
       LIMIT 1`,
      [tokenHash],
    );
    const device = rows.at(0);
    if (!device) {
      throw new UnauthorizedException("Invalid or revoked device token");
    }

    // Auto-heal false-positive revokes (unstable HW fingerprint used to kill
    // legitimate devices). Valid token possession is enough to restore access.
    if (device.revoked_at) {
      await this.postgres.query(
        `UPDATE public.ac_devices
         SET revoked_at = NULL, last_seen_at = now()
         WHERE id = $1::uuid`,
        [device.id],
      );
      this.logger.warn(
        `AC auto-unrevoke device=${device.id} steam=${device.steam_id}`,
      );
    } else {
      await this.postgres.query(
        `UPDATE public.ac_devices SET last_seen_at = now() WHERE id = $1`,
        [device.id],
      );
    }

    return {
      id: device.id,
      steam_id: device.steam_id,
      hardware_hash: device.hardware_hash,
    };
  }

  /**
   * Issue a one-time challenge the launcher must HMAC with its device token.
   * Without this, a stolen token can be replayed by a fake client forever.
   */
  public async issueChallenge(deviceToken: string): Promise<{
    challenge: string;
    expires_in: number;
    min_version: string;
  }> {
    const device = await this.resolveDevice(deviceToken);
    try {
      return await this.insertChallenge(device.id);
    } catch (err) {
      this.logger.warn(`AC challenge insert failed, ensuring schema: ${err}`);
      await this.ensureSecuritySchema();
      return await this.insertChallenge(device.id);
    }
  }

  private async insertChallenge(deviceId: string): Promise<{
    challenge: string;
    expires_in: number;
    min_version: string;
  }> {
    const challenge = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);

    await this.postgres.query(
      `DELETE FROM public.ac_challenges
       WHERE device_id = $1::uuid
         AND (used_at IS NOT NULL OR expires_at < now())`,
      [deviceId],
    );

    await this.postgres.query(
      `INSERT INTO public.ac_challenges (device_id, challenge_hash, expires_at)
       VALUES ($1::uuid, $2, $3)`,
      [deviceId, this.hashChallenge(challenge), expires.toISOString()],
    );

    return {
      challenge,
      expires_in: CHALLENGE_TTL_SECONDS,
      min_version: MIN_CLIENT_VERSION,
    };
  }

  private async consumeChallenge(
    deviceId: string,
    challenge: string,
  ): Promise<void> {
    const challengeHash = this.hashChallenge(challenge);
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.ac_challenges
       SET used_at = now()
       WHERE device_id = $1::uuid
         AND challenge_hash = $2
         AND used_at IS NULL
         AND expires_at > now()
       RETURNING id::text`,
      [deviceId, challengeHash],
    );
    if (rows.length === 0) {
      throw new UnauthorizedException("Invalid or expired attest challenge");
    }
  }

  private async bindOrVerifyHardware(
    deviceId: string,
    hardwareHash: string,
  ): Promise<void> {
    const hash = String(hardwareHash || "")
      .trim()
      .toLowerCase()
      .slice(0, 128);
    if (!/^[a-f0-9]{16,128}$/.test(hash)) {
      throw new BadRequestException("Invalid hardware fingerprint");
    }

    const rows = await this.postgres.query<
      Array<{ hardware_hash: string | null }>
    >(
      `SELECT hardware_hash FROM public.ac_devices WHERE id = $1::uuid LIMIT 1`,
      [deviceId],
    );
    const existing = rows.at(0)?.hardware_hash?.trim().toLowerCase() || null;

    if (!existing) {
      await this.postgres.query(
        `UPDATE public.ac_devices
         SET hardware_hash = $2
         WHERE id = $1::uuid AND hardware_hash IS NULL`,
        [deviceId, hash],
      );
      return;
    }

    if (timingSafeStringEqual(existing, hash)) {
      return;
    }

    // Valid HMAC already proved token possession. Re-bind instead of revoking —
    // WMI disk/name churn was false-positive revoking real players.
    await this.postgres.query(
      `UPDATE public.ac_devices
       SET hardware_hash = $2
       WHERE id = $1::uuid`,
      [deviceId, hash],
    );
    this.logger.warn(
      `AC hardware fingerprint updated device=${deviceId} (no revoke)`,
    );
  }

  public evaluatePass(checks: AcChecks, req: AcRequirements): boolean {
    if (req.secure_boot && !checks.secure_boot) return false;
    if (req.iommu && !checks.iommu) return false;
    if (req.tpm_20 && !checks.tpm_20) return false;
    if (req.tpm_attestation && !checks.tpm_attestation) return false;
    if (req.hvci && !checks.hvci) return false;
    if (req.windows_updates && !checks.windows_updates) return false;
    return true;
  }

  public async profileForDevice(deviceToken: string) {
    const device = await this.resolveDevice(deviceToken);
    const rows = await this.postgres.query<
      Array<{
        steam_id: string;
        name: string | null;
        avatar_url: string | null;
        created_at: string;
      }>
    >(
      `SELECT steam_id::text, name, avatar_url, created_at::text
       FROM public.players
       WHERE steam_id = $1
       LIMIT 1`,
      [device.steam_id],
    );
    const player = rows.at(0);
    const valid = await this.hasValidAttestation(device.steam_id);
    return {
      steam_id: device.steam_id,
      name: player?.name || device.steam_id,
      avatar_url: player?.avatar_url || null,
      member_since: player?.created_at || null,
      attested: valid,
    };
  }

  /** Prefix for auto bans issued by the AC launcher (safe to lift when fixed). */
  private static readonly AcBanPrefix = "YGuard AC:";
  private static readonly AcSecurityBanReason =
    "YGuard AC: security requirements not met";

  public async submitAttestation(
    deviceToken: string,
    body: AcChecks & {
      os_version?: string;
      hardware_hash?: string;
      /** Client also reports whether the local cheat scan is clean this tick. */
      cheat_clean?: boolean;
      /** One-time challenge from POST /plugins/ac/challenge */
      challenge?: string;
      /** Unix epoch seconds when the client signed */
      ts?: number;
      /** HMAC-SHA256 hex of attestCanonical(...) using the device token */
      signature?: string;
      /** Launcher assembly version, e.g. 0.3.0 */
      client_version?: string;
    },
  ) {
    const device = await this.resolveDevice(deviceToken);

    const clientVersion = String(body.client_version || "").trim();
    if (!this.isVersionAtLeast(clientVersion, MIN_CLIENT_VERSION)) {
      throw new ForbiddenException(
        `Update YGuard Anti-Cheat to ${MIN_CLIENT_VERSION} or newer`,
      );
    }

    const challenge = String(body.challenge || "").trim();
    const signature = String(body.signature || "").trim().toLowerCase();
    const ts = Number(body.ts);
    if (!challenge || !signature || !Number.isFinite(ts)) {
      throw new BadRequestException("Signed attest challenge required");
    }
    const skew = Math.abs(Date.now() / 1000 - ts);
    if (skew > ATTEST_CLOCK_SKEW_SECONDS) {
      throw new UnauthorizedException("Attest timestamp out of range");
    }

    const hardwareHash = String(body.hardware_hash || "")
      .trim()
      .toLowerCase();
    const checks: AcChecks = {
      secure_boot: !!body.secure_boot,
      iommu: !!body.iommu,
      tpm_20: !!body.tpm_20,
      tpm_attestation: !!body.tpm_attestation,
      hvci: !!body.hvci,
      windows_updates: !!body.windows_updates,
    };
    const cheatClean = !!body.cheat_clean;

    const canonical = AnticheatService.attestCanonical({
      challenge,
      ts: Math.trunc(ts),
      client_version: clientVersion,
      hardware_hash: hardwareHash,
      ...checks,
      cheat_clean: cheatClean,
    });
    const expected = this.signAttest(deviceToken.trim(), canonical);
    if (!this.timingSafeHexEqual(expected, signature)) {
      throw new UnauthorizedException("Invalid attest signature");
    }

    await this.consumeChallenge(device.id, challenge);
    await this.bindOrVerifyHardware(device.id, hardwareHash);

    await this.postgres.query(
      `UPDATE public.ac_devices
       SET client_version = $2
       WHERE id = $1::uuid`,
      [device.id, clientVersion.slice(0, 32)],
    );

    const req = await this.getRequirements();
    const passed = this.evaluatePass(checks, req);
    const expires = new Date(Date.now() + req.ttl_minutes * 60 * 1000);

    const rows = await this.postgres.query<
      Array<{ id: string; expires_at: string }>
    >(
      `INSERT INTO public.ac_attestations (
         steam_id, device_id,
         secure_boot, iommu, tpm_20, tpm_attestation, hvci, windows_updates,
         os_version, hardware_hash, passed, expires_at
       ) VALUES (
         $1, $2,
         $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12
       )
       RETURNING id::text, expires_at::text`,
      [
        device.steam_id,
        device.id,
        checks.secure_boot,
        checks.iommu,
        checks.tpm_20,
        checks.tpm_attestation,
        checks.hvci,
        checks.windows_updates,
        (body.os_version || "").slice(0, 120) || null,
        hardwareHash.slice(0, 128) || null,
        passed,
        expires.toISOString(),
      ],
    );

    // Failed checks → no valid attestation (queue blocked). Not a platform ban.
    // Cheat detections still ban via /report.
    if (!passed) {
      await this.postgres.query(
        `UPDATE public.ac_attestations
         SET expires_at = now()
         WHERE steam_id = $1 AND expires_at > now() AND id <> $2::uuid`,
        [device.steam_id, rows.at(0)?.id],
      );
      // Ensure the just-inserted failing row cannot be treated as valid.
      await this.postgres.query(
        `UPDATE public.ac_attestations SET expires_at = now() WHERE id = $1::uuid`,
        [rows.at(0)?.id],
      );
    } else {
      await this.liftAcBans(device.steam_id, "security");
    }

    // If client says cheats are gone AND checks pass, lift cheat auto-bans too.
    let unbanned = false;
    if (passed && cheatClean) {
      unbanned = await this.liftAcBans(device.steam_id, "all");
    }

    const banned = await this.hasActiveBan(device.steam_id);

    return {
      passed: passed && !banned,
      expires_at: passed ? rows.at(0)?.expires_at : null,
      attestation_id: rows.at(0)?.id,
      requirements: req,
      checks,
      banned,
      unbanned,
    };
  }

  /** Latest published Windows launcher build (client auto-update). */
  public getLauncherRelease(): {
    version: string;
    download_url: string;
    mandatory: boolean;
    min_version: string;
  } {
    // Advertise real latest so older clients get the update prompt.
    // Override with AC_LAUNCHER_VERSION / AC_LAUNCHER_DOWNLOAD_URL if needed.
    const version = process.env.AC_LAUNCHER_VERSION || "0.3.6";
    return {
      version,
      download_url:
        process.env.AC_LAUNCHER_DOWNLOAD_URL ||
        "https://github.com/kianPk/web/releases/download/client-v0.3.6/YGuardAC-0.3.6-client.zip",
      // Force upgrade past clients that still show the old pair-again 401 text.
      mandatory: true,
      min_version: MIN_CLIENT_VERSION,
    };
  }

  private async hasActiveBan(steamId: string): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text
       FROM public.player_sanctions
       WHERE player_steam_id = $1::bigint
         AND type = 'ban'
         AND deleted_at IS NULL
         AND (remove_sanction_date IS NULL OR remove_sanction_date > now())
       LIMIT 1`,
      [steamId],
    );
    return rows.length > 0;
  }

  private async ensureAcBan(steamId: string, reason: string): Promise<boolean> {
    const existing = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text
       FROM public.player_sanctions
       WHERE player_steam_id = $1::bigint
         AND type = 'ban'
         AND deleted_at IS NULL
         AND (remove_sanction_date IS NULL OR remove_sanction_date > now())
         AND reason = $2
       LIMIT 1`,
      [steamId, reason.slice(0, 240)],
    );
    if (existing.length > 0) return false;
    await this.postgres.query(
      `INSERT INTO public.player_sanctions
         (type, player_steam_id, sanctioned_by_steam_id, reason)
       VALUES ('ban', $1::bigint, NULL, $2)`,
      [steamId, reason.slice(0, 240)],
    );
    this.logger.warn(`AC auto-ban steam=${steamId} reason=${reason}`);
    return true;
  }

  /**
   * Soft-delete auto bans issued by YGuard AC.
   * scope=security → only the security-requirements ban
   * scope=cheat → bans whose reason mentions detection / cheat
   * scope=all → every reason starting with "YGuard AC:"
   */
  private async liftAcBans(
    steamId: string,
    scope: "security" | "cheat" | "all",
  ): Promise<boolean> {
    let reasonFilter = `reason LIKE $2`;
    let pattern = `${AnticheatService.AcBanPrefix}%`;
    if (scope === "security") {
      reasonFilter = `reason = $2`;
      pattern = AnticheatService.AcSecurityBanReason;
    } else if (scope === "cheat") {
      reasonFilter = `reason LIKE $2 AND reason <> $3`;
      // handled below with 3 params
    }

    let result: Array<{ id: string }>;
    if (scope === "cheat") {
      result = await this.postgres.query(
        `UPDATE public.player_sanctions
         SET deleted_at = now()
         WHERE player_steam_id = $1::bigint
           AND type = 'ban'
           AND deleted_at IS NULL
           AND reason LIKE $2
           AND reason <> $3
         RETURNING id::text`,
        [
          steamId,
          `${AnticheatService.AcBanPrefix}%`,
          AnticheatService.AcSecurityBanReason,
        ],
      );
    } else {
      result = await this.postgres.query(
        `UPDATE public.player_sanctions
         SET deleted_at = now()
         WHERE player_steam_id = $1::bigint
           AND type = 'ban'
           AND deleted_at IS NULL
           AND ${reasonFilter}
         RETURNING id::text`,
        [steamId, pattern],
      );
    }

    if (result.length > 0) {
      this.logger.log(
        `AC lifted ${result.length} auto-ban(s) steam=${steamId} scope=${scope}`,
      );
      return true;
    }
    return false;
  }

  /** True when every steam id has a fresh passing attestation (or AC is off). */
  public async assertPlayersReady(steamIds: string[]): Promise<void> {
    const req = await this.getRequirements();
    if (!req.required) return;

    const unique = [...new Set(steamIds.map(String))];
    for (const steamId of unique) {
      const ok = await this.hasValidAttestation(steamId);
      if (!ok) {
        throw new ForbiddenException(
          "Open YGuard Anti-Cheat and keep it running, then try again.",
        );
      }
    }
  }

  public async hasValidAttestation(steamId: string): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT a.id::text
       FROM public.ac_attestations a
       JOIN public.ac_devices d ON d.id = a.device_id
       WHERE a.steam_id = $1
         AND a.passed = true
         AND a.expires_at > now()
         AND d.revoked_at IS NULL
         AND d.last_seen_at > now() - ($2::text || ' seconds')::interval
       ORDER BY a.expires_at DESC
       LIMIT 1`,
      [steamId, String(DEVICE_ALIVE_SECONDS)],
    );
    return rows.length > 0;
  }

  /**
   * Launcher closed / logging out — drop attestation immediately and kick from
   * the live match (no platform ban). Re-open AC + attest → can rejoin.
   */
  public async disconnectDevice(deviceToken: string): Promise<{
    ok: true;
    kicked: boolean;
  }> {
    const device = await this.resolveDevice(deviceToken);
    await this.postgres.query(
      `UPDATE public.ac_attestations
       SET expires_at = now()
       WHERE steam_id = $1 AND expires_at > now()`,
      [device.steam_id],
    );
    // Push last_seen into the past so hasValidAttestation fails immediately.
    await this.postgres.query(
      `UPDATE public.ac_devices
       SET last_seen_at = now() - interval '10 minutes'
       WHERE id = $1`,
      [device.id],
    );
    const kicked = await this.kickLiveIfAcOffline(device.steam_id);
    return { ok: true, kicked };
  }

  public async statusForPlayer(steamId: string) {
    const req = await this.getRequirements();
    const rows = await this.postgres.query<
      Array<{
        passed: boolean;
        expires_at: string;
        secure_boot: boolean;
        iommu: boolean;
        tpm_20: boolean;
        tpm_attestation: boolean;
        hvci: boolean;
        windows_updates: boolean;
      }>
    >(
      `SELECT passed, expires_at::text,
              secure_boot, iommu, tpm_20, tpm_attestation, hvci, windows_updates
       FROM public.ac_attestations
       WHERE steam_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [steamId],
    );
    const latest = rows.at(0) ?? null;
    const valid = await this.hasValidAttestation(steamId);
    const banned = await this.hasActiveBan(steamId);
    return {
      required: req.required,
      valid,
      banned,
      requirements: req,
      latest,
    };
  }

  private async liftAllSecurityBans(): Promise<void> {
    const result = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.player_sanctions
       SET deleted_at = now()
       WHERE type = 'ban'
         AND deleted_at IS NULL
         AND reason = $1
       RETURNING id::text`,
      [AnticheatService.AcSecurityBanReason],
    );
    if (result.length > 0) {
      this.logger.log(`AC cleaned ${result.length} leftover security ban(s)`);
    }
  }

  /**
   * Game-server plugin gate: Bearer = servers.api_password.
   * When AC is required, every connecting player (ranked / custom / public)
   * must have a live AC launcher — not only match lineup roster.
   */
  public async checkPlayerForServer(
    serverId: string,
    steamId: string,
    authorization?: string,
  ): Promise<{ required: boolean; allowed: boolean; reason?: string }> {
    const sid = String(serverId || "").trim();
    const steam = String(steamId || "").trim();
    if (!sid || !steam) {
      throw new BadRequestException("server_id and steam_id required");
    }

    const apiPassword = String(authorization || "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    const servers = await this.postgres.query<
      Array<{ api_password: string | null }>
    >(
      `SELECT api_password::text AS api_password
       FROM public.servers
       WHERE id = $1::uuid
       LIMIT 1`,
      [sid],
    );
    const row = servers.at(0);
    if (!row || !timingSafeStringEqual(row.api_password, apiPassword)) {
      throw new UnauthorizedException("Invalid server credentials");
    }

    const req = await this.getRequirements();
    if (!req.required) {
      return { required: false, allowed: true };
    }

    const ok = await this.hasValidAttestation(steam);
    if (ok) {
      return { required: true, allowed: true };
    }
    return {
      required: true,
      allowed: false,
      reason: "YGuard AC: reopen the Anti-Cheat launcher",
    };
  }

  /**
   * Called when FiveStack reports player-connected. Lineup players without a
   * live AC launcher are kicked immediately (with retries until status shows them).
   */
  public async enforceConnectedPlayer(
    matchId: string,
    steamId: string,
  ): Promise<void> {
    const req = await this.getRequirements();
    if (!req.required) return;

    const inLineup = await this.postgres.query<Array<{ ok: number }>>(
      `SELECT 1 AS ok
       FROM public.matches m
       JOIN public.match_lineup_players mlp
         ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
       WHERE m.id = $1::uuid
         AND mlp.steam_id = $2::bigint
       LIMIT 1`,
      [matchId, steamId],
    );
    if (inLineup.length === 0) return;

    if (await this.hasValidAttestation(steamId)) return;

    const servers = await this.postgres.query<Array<{ server_id: string }>>(
      `SELECT server_id::text AS server_id
       FROM public.matches
       WHERE id = $1::uuid AND server_id IS NOT NULL
       LIMIT 1`,
      [matchId],
    );
    const serverId = servers.at(0)?.server_id;
    if (!serverId) return;

    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 600));
      }
      if (await this.hasValidAttestation(steamId)) return;
      const kicked = await this.kickOnServer(
        serverId,
        steamId,
        "YGuard AC: reopen the Anti-Cheat launcher",
      );
      if (kicked) {
        this.logger.warn(
          `AC kick on connect steam=${steamId} match=${matchId} attempt=${attempt + 1}`,
        );
        return;
      }
    }
    this.logger.warn(
      `AC kick on connect FAILED steam=${steamId} match=${matchId} (player not found via RCON)`,
    );
  }

  /** Kick anyone in a live match whose AC launcher is offline / not attested. */
  private async enforceLiveMatchAc(): Promise<void> {
    const req = await this.getRequirements();
    if (!req.required) return;

    const rows = await this.postgres.query<
      Array<{ steam_id: string; server_id: string }>
    >(
      `SELECT DISTINCT mlp.steam_id::text AS steam_id, m.server_id::text AS server_id
       FROM public.matches m
       JOIN public.match_lineup_players mlp
         ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
       WHERE m.server_id IS NOT NULL
         AND m.status NOT IN (
           'Canceled', 'Finished', 'Forfeit', 'Surrendered', 'Tie', 'Veto'
         )`,
    );

    for (const row of rows) {
      const ok = await this.hasValidAttestation(row.steam_id);
      if (ok) continue;
      await this.kickOnServer(
        row.server_id,
        row.steam_id,
        "YGuard AC: reopen the Anti-Cheat launcher",
      );
    }
  }

  private async kickLiveIfAcOffline(steamId: string): Promise<boolean> {
    const live = await this.findLiveMatchServer(steamId);
    if (!live?.server_id) return false;
    return this.kickOnServer(
      live.server_id,
      steamId,
      "YGuard AC: reopen the Anti-Cheat launcher",
    );
  }

  private async kickOnServer(
    serverId: string,
    steamId: string,
    reason: string,
  ): Promise<boolean> {
    try {
      const { DedicatedServersService } = await import(
        "../dedicated-servers/dedicated-servers.service"
      );
      const dedicated = this.moduleRef.get(DedicatedServersService, {
        strict: false,
      });
      if (!dedicated?.kickSteamId) return false;
      const ok = await dedicated.kickSteamId(serverId, steamId, reason);
      if (ok) {
        this.logger.warn(
          `AC kick steam=${steamId} server=${serverId} reason=${reason}`,
        );
      }
      return ok;
    } catch (err) {
      this.logger.warn(`AC kick failed steam=${steamId}: ${err}`);
      return false;
    }
  }

  /**
   * Launcher cheat scan result.
   * - hits present → permanent platform ban (lifted only after a clean scan + pass)
   * - clean:true / empty hits → lift AC cheat auto-bans if security also passes
   */
  public async reportCheatHits(
    deviceToken: string,
    hits: Array<{
      signature?: string;
      path?: string;
      process_name?: string;
      details?: Record<string, unknown>;
    }>,
    opts?: { clean?: boolean },
  ): Promise<{
    banned: boolean;
    kicked: boolean;
    already_banned: boolean;
    unbanned: boolean;
    signatures: string[];
  }> {
    const device = await this.resolveDevice(deviceToken);
    const cleaned: AcCheatHit[] = (hits || [])
      .map((h) => ({
        signature: String(h?.signature || "")
          .trim()
          .slice(0, 64)
          .toLowerCase(),
        path: h?.path ? String(h.path).slice(0, 512) : undefined,
        process_name: h?.process_name
          ? String(h.process_name).slice(0, 128)
          : undefined,
        details:
          h?.details && typeof h.details === "object" ? h.details : undefined,
      }))
      .filter((h) => h.signature.length > 0);

    // Clean report: remove cheat files → lift AC cheat bans (keep security ban if any).
    if (cleaned.length === 0 || opts?.clean === true) {
      const unbanned = await this.liftAcBans(device.steam_id, "cheat");
      // Only fully clear play lock if they also have a fresh passing attestation.
      const ok = await this.hasValidAttestation(device.steam_id);
      if (ok) {
        await this.liftAcBans(device.steam_id, "all");
      }
      const banned = await this.hasActiveBan(device.steam_id);
      return {
        banned,
        kicked: false,
        already_banned: banned,
        unbanned,
        signatures: [],
      };
    }

    const signatures = [...new Set(cleaned.map((h) => h.signature))];
    const reason = `${AnticheatService.AcBanPrefix} ${signatures.join(", ")} detected`;

    for (const hit of cleaned) {
      await this.postgres.query(
        `INSERT INTO public.ac_detections
           (steam_id, device_id, signature, path, process_name, details, banned)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, false)`,
        [
          device.steam_id,
          device.id,
          hit.signature,
          hit.path ?? null,
          hit.process_name ?? null,
          JSON.stringify(hit.details || {}),
        ],
      );
    }

    // Invalidate any current attestation so they cannot queue.
    await this.postgres.query(
      `UPDATE public.ac_attestations
       SET expires_at = now()
       WHERE steam_id = $1 AND expires_at > now()`,
      [device.steam_id],
    );

    const alreadyBanned = await this.hasActiveBan(device.steam_id);
    // Always ensure a cheat-specific ban row (even if a security ban already exists).
    await this.ensureAcBan(device.steam_id, reason);

    await this.postgres.query(
      `UPDATE public.ac_detections
       SET banned = true
       WHERE steam_id = $1
         AND created_at > now() - interval '2 minutes'
         AND signature = ANY($2::text[])`,
      [device.steam_id, signatures],
    );

    let kicked = false;
    const live = await this.findLiveMatchServer(device.steam_id);
    if (live?.server_id) {
      this.logger.warn(
        `AC cheat ban steam=${device.steam_id} on live server=${live.server_id} match=${live.match_id} (platform ban applied; kick on next sync)`,
      );
      kicked = false;
    }

    return {
      banned: true,
      kicked,
      already_banned: alreadyBanned,
      unbanned: false,
      signatures,
    };
  }

  private async findLiveMatchServer(
    steamId: string,
  ): Promise<{ server_id: string; match_id: string } | null> {
    const rows = await this.postgres.query<
      Array<{ server_id: string; match_id: string }>
    >(
      `SELECT m.server_id::text AS server_id, m.id::text AS match_id
       FROM public.matches m
       JOIN public.match_lineup_players mlp
         ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
       WHERE mlp.steam_id = $1::bigint
         AND m.server_id IS NOT NULL
         AND m.status NOT IN (
           'Canceled', 'Finished', 'Forfeit', 'Surrendered', 'Tie'
         )
       ORDER BY m.created_at DESC
       LIMIT 1`,
      [steamId],
    );
    return rows.at(0) ?? null;
  }
}
