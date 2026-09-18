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
import { createHash, randomBytes } from "crypto";
import { PostgresService } from "../postgres/postgres.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";

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
const DEVICE_ALIVE_SECONDS = 90;

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

    this.enforceTimer = setInterval(() => {
      void this.enforceLiveMatchAc().catch((err) =>
        this.logger.warn(`AC live enforce failed: ${err}`),
      );
    }, 30_000);
  }

  public onModuleDestroy() {
    if (this.enforceTimer) clearInterval(this.enforceTimer);
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
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
  }> {
    if (!deviceToken?.trim()) {
      throw new UnauthorizedException("Device token required");
    }
    const tokenHash = this.hashToken(deviceToken.trim());
    const rows = await this.postgres.query<
      Array<{ id: string; steam_id: string }>
    >(
      `SELECT id::text, steam_id::text
       FROM public.ac_devices
       WHERE device_token_hash = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [tokenHash],
    );
    const device = rows.at(0);
    if (!device) {
      throw new UnauthorizedException("Invalid or revoked device token");
    }
    await this.postgres.query(
      `UPDATE public.ac_devices SET last_seen_at = now() WHERE id = $1`,
      [device.id],
    );
    return device;
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
    },
  ) {
    const device = await this.resolveDevice(deviceToken);
    const req = await this.getRequirements();
    const checks: AcChecks = {
      secure_boot: !!body.secure_boot,
      iommu: !!body.iommu,
      tpm_20: !!body.tpm_20,
      tpm_attestation: !!body.tpm_attestation,
      hvci: !!body.hvci,
      windows_updates: !!body.windows_updates,
    };
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
        (body.hardware_hash || "").slice(0, 128) || null,
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
    if (passed && body.cheat_clean === true) {
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
  } {
    // Advertise real latest so older clients get the update prompt.
    // Override with AC_LAUNCHER_VERSION / AC_LAUNCHER_DOWNLOAD_URL if needed.
    return {
      version: process.env.AC_LAUNCHER_VERSION || "0.2.5",
      download_url:
        process.env.AC_LAUNCHER_DOWNLOAD_URL ||
        "https://github.com/kianPk/web/releases/download/client-v0.2.5/YGuardAC-0.2.5-client.zip",
      mandatory: false,
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
    // Resolve Rcon / DedicatedServers at call-time via ModuleRef so AnticheatModule
    // does not import them (that created a Nest circular graph and broke CI).
    let rcon: { connect: Function; disconnect: Function } | undefined;
    try {
      const { DedicatedServersService } = await import(
        "../dedicated-servers/dedicated-servers.service"
      );
      const { RconService } = await import("../rcon/rcon.service");
      const dedicated = this.moduleRef.get(DedicatedServersService, {
        strict: false,
      });
      rcon = this.moduleRef.get(RconService, { strict: false });
      if (!dedicated || !rcon) return false;

      const userid = await dedicated.resolveServerUserId(serverId, steamId);
      if (!userid) return false;
      const client = await rcon.connect(serverId);
      if (!client) return false;
      const safe = reason.replace(/[\r\n";]/g, " ").trim().slice(0, 120);
      await client.send(`kickid ${userid} ${safe}`);
      this.logger.warn(
        `AC kick steam=${steamId} server=${serverId} reason=${safe}`,
      );
      return true;
    } catch (err) {
      this.logger.warn(`AC kick failed steam=${steamId}: ${err}`);
      return false;
    } finally {
      try {
        await rcon?.disconnect(serverId);
      } catch {
        /* ignore */
      }
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
