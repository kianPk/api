import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
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

@Injectable()
export class AnticheatService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly logger: Logger,
  ) {}

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
      this.settingNumber(SystemSettingName.AcAttestationTtlMinutes, 3),
      this.settingFlag(SystemSettingName.AcRequireSecureBoot, true),
      this.settingFlag(SystemSettingName.AcRequireTpm, true),
      this.settingFlag(SystemSettingName.AcRequireHvci, false),
      this.settingFlag(SystemSettingName.AcRequireIommu, false),
      this.settingFlag(SystemSettingName.AcRequireWindowsUpdates, false),
    ]);

    return {
      required,
      ttl_minutes: Math.max(5, Math.min(120, ttl)),
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

  public async submitAttestation(
    deviceToken: string,
    body: AcChecks & { os_version?: string; hardware_hash?: string },
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

    return {
      passed,
      expires_at: rows.at(0)?.expires_at,
      attestation_id: rows.at(0)?.id,
      requirements: req,
      checks,
    };
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
          `YGuard Anti-Cheat required. Open the launcher, keep it running, pass all checks, then try again. (SteamID ${steamId})`,
        );
      }
    }
  }

  public async hasValidAttestation(steamId: string): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text
       FROM public.ac_attestations
       WHERE steam_id = $1
         AND passed = true
         AND expires_at > now()
       ORDER BY expires_at DESC
       LIMIT 1`,
      [steamId],
    );
    return rows.length > 0;
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
    return {
      required: req.required,
      valid,
      requirements: req,
      latest,
    };
  }

  /**
   * Launcher found known cheat files/processes on the PC.
   * Logs hits, issues a permanent platform ban, and kicks from live match if any.
   */
  public async reportCheatHits(
    deviceToken: string,
    hits: Array<{
      signature?: string;
      path?: string;
      process_name?: string;
      details?: Record<string, unknown>;
    }>,
  ): Promise<{
    banned: boolean;
    kicked: boolean;
    already_banned: boolean;
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

    if (cleaned.length === 0) {
      throw new BadRequestException("No cheat hits provided");
    }

    const signatures = [...new Set(cleaned.map((h) => h.signature))];
    const primary = cleaned[0];
    const reason = `YGuard AC: ${signatures.join(", ")} detected`;

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

    const already = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text
       FROM public.player_sanctions
       WHERE player_steam_id = $1::bigint
         AND type = 'ban'
         AND deleted_at IS NULL
         AND (remove_sanction_date IS NULL OR remove_sanction_date > now())
       LIMIT 1`,
      [device.steam_id],
    );
    const alreadyBanned = already.length > 0;

    let banned = alreadyBanned;
    if (!alreadyBanned) {
      await this.postgres.query(
        `INSERT INTO public.player_sanctions
           (type, player_steam_id, sanctioned_by_steam_id, reason)
         VALUES ('ban', $1::bigint, NULL, $2)`,
        [device.steam_id, reason.slice(0, 240)],
      );
      banned = true;
      this.logger.warn(
        `AC cheat ban steam=${device.steam_id} sigs=${signatures.join(",")}`,
      );
    }

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
      // Live kick goes through the next match sync / player_sanctions poll.
      // We intentionally do not import SanctionsModule here — that created a
      // Nest circular import (Matchmaking → Anticheat → Sanctions → …).
      this.logger.warn(
        `AC cheat ban steam=${device.steam_id} on live server=${live.server_id} match=${live.match_id} (platform ban applied; kick on next sync)`,
      );
      kicked = false;
    }

    return {
      banned,
      kicked,
      already_banned: alreadyBanned,
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
