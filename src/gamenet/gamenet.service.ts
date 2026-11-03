import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";

const SESSION_TTL_HOURS = 6;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type GamenetCodeRow = {
  id: string;
  code: string;
  label: string;
  note: string;
  club_id: string | null;
  club_name: string | null;
  max_devices: number;
  created_by_steam_id: string | null;
  created_at: string;
  revoked_at: string | null;
  device_count: number;
  active_device_count: number;
  active_session_count: number;
};

export type GamenetDeviceRow = {
  id: string;
  code_id: string;
  device_id: string;
  device_label: string;
  bound_by_steam_id: string | null;
  bound_by_name: string | null;
  bound_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

@Injectable()
export class GamenetService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly logger: Logger,
  ) {}

  public async listCodes(): Promise<GamenetCodeRow[]> {
    return this.postgres.query<GamenetCodeRow[]>(
      `SELECT c.id::text AS id,
              c.code,
              c.label,
              c.note,
              c.club_id::text AS club_id,
              cl.name AS club_name,
              c.max_devices,
              c.created_by_steam_id::text AS created_by_steam_id,
              c.created_at::text,
              c.revoked_at::text,
              (
                SELECT COUNT(*)::int FROM public.gamenet_devices d
                 WHERE d.code_id = c.id
              ) AS device_count,
              (
                SELECT COUNT(*)::int FROM public.gamenet_devices d
                 WHERE d.code_id = c.id AND d.revoked_at IS NULL
              ) AS active_device_count,
              (
                SELECT COUNT(*)::int
                  FROM public.gamenet_sessions s
                  JOIN public.gamenet_devices d ON d.id = s.device_row_id
                 WHERE d.code_id = c.id
                   AND d.revoked_at IS NULL
                   AND s.expires_at > now()
              ) AS active_session_count
         FROM public.gamenet_codes c
         LEFT JOIN public.clubs cl ON cl.id = c.club_id
        ORDER BY (c.revoked_at IS NULL) DESC, c.created_at DESC
        LIMIT 500`,
    );
  }

  public async listDevices(codeId: string): Promise<GamenetDeviceRow[]> {
    this.assertUuid(codeId);
    return this.postgres.query<GamenetDeviceRow[]>(
      `SELECT d.id::text AS id,
              d.code_id::text AS code_id,
              d.device_id,
              d.device_label,
              d.bound_by_steam_id::text AS bound_by_steam_id,
              p.name AS bound_by_name,
              d.bound_at::text,
              d.last_seen_at::text,
              d.revoked_at::text
         FROM public.gamenet_devices d
         LEFT JOIN public.players p ON p.steam_id = d.bound_by_steam_id
        WHERE d.code_id = $1::uuid
        ORDER BY (d.revoked_at IS NULL) DESC, d.last_seen_at DESC
        LIMIT 500`,
      [codeId],
    );
  }

  public async createCode(
    user: User,
    input: {
      label?: string;
      note?: string;
      club_id?: string | null;
      max_devices?: number;
      code?: string;
    },
  ): Promise<GamenetCodeRow> {
    const label = String(input?.label || "").trim().slice(0, 120);
    if (label.length < 2) {
      throw new BadRequestException("label required");
    }
    const note = String(input?.note || "").trim().slice(0, 500);
    const maxDevices = Math.min(
      500,
      Math.max(1, Math.floor(Number(input?.max_devices) || 50)),
    );
    let clubId: string | null = null;
    const rawClub = String(input?.club_id || "").trim();
    if (rawClub) {
      this.assertUuid(rawClub);
      const clubs = await this.postgres.query<Array<{ id: string }>>(
        `SELECT id::text AS id FROM public.clubs WHERE id = $1::uuid`,
        [rawClub],
      );
      if (!clubs[0]) throw new BadRequestException("club not found");
      clubId = rawClub;
    }

    let code = this.normalizeCode(input?.code || "");
    if (!code) code = this.generateCode();
    if (!/^[A-Z0-9]{6,16}$/.test(code)) {
      throw new BadRequestException("invalid code format");
    }

    try {
      await this.postgres.query(
        `INSERT INTO public.gamenet_codes
           (code, label, note, club_id, max_devices, created_by_steam_id)
         VALUES ($1, $2, $3, $4::uuid, $5, $6::bigint)`,
        [code, label, note, clubId, maxDevices, user.steam_id],
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("gamenet_codes_code_uidx")) {
        throw new BadRequestException("code already exists");
      }
      throw error;
    }

    const rows = await this.listCodes();
    const created = rows.find((r) => r.code === code);
    if (!created) throw new BadRequestException("could not create code");
    this.logger.log(
      `gamenet code created code=${code} label=${label} by=${user.steam_id}`,
    );
    return created;
  }

  public async revokeCode(user: User, codeId: string) {
    this.assertUuid(codeId);
    const updated = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.gamenet_codes
          SET revoked_at = now()
        WHERE id = $1::uuid AND revoked_at IS NULL
      RETURNING id::text AS id`,
      [codeId],
    );
    if (!updated[0]) throw new BadRequestException("code not found or revoked");
    await this.postgres.query(
      `UPDATE public.gamenet_devices
          SET revoked_at = COALESCE(revoked_at, now())
        WHERE code_id = $1::uuid AND revoked_at IS NULL`,
      [codeId],
    );
    await this.postgres.query(
      `UPDATE public.gamenet_sessions s
          SET expires_at = least(expires_at, now())
         FROM public.gamenet_devices d
        WHERE d.id = s.device_row_id
          AND d.code_id = $1::uuid`,
      [codeId],
    );
    this.logger.log(`gamenet code revoked id=${codeId} by=${user.steam_id}`);
    return { success: true };
  }

  public async revokeDevice(user: User, deviceRowId: string) {
    this.assertUuid(deviceRowId);
    const updated = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.gamenet_devices
          SET revoked_at = now()
        WHERE id = $1::uuid AND revoked_at IS NULL
      RETURNING id::text AS id`,
      [deviceRowId],
    );
    if (!updated[0]) {
      throw new BadRequestException("device not found or revoked");
    }
    await this.postgres.query(
      `UPDATE public.gamenet_sessions
          SET expires_at = least(expires_at, now())
        WHERE device_row_id = $1::uuid`,
      [deviceRowId],
    );
    this.logger.log(
      `gamenet device revoked id=${deviceRowId} by=${user.steam_id}`,
    );
    return { success: true };
  }

  public async redeemCode(
    user: User,
    input: { code?: string; device_id?: string; device_label?: string },
  ) {
    const code = this.normalizeCode(input?.code || "");
    const deviceId = String(input?.device_id || "").trim();
    const deviceLabel = String(input?.device_label || "")
      .trim()
      .slice(0, 120);
    if (!code) throw new BadRequestException("code required");
    if (deviceId.length < 8 || deviceId.length > 128) {
      throw new BadRequestException("device_id required");
    }

    const codes = await this.postgres.query<
      Array<{
        id: string;
        label: string;
        club_id: string | null;
        club_name: string | null;
        max_devices: number;
      }>
    >(
      `SELECT c.id::text AS id,
              c.label,
              c.club_id::text AS club_id,
              cl.name AS club_name,
              c.max_devices
         FROM public.gamenet_codes c
         LEFT JOIN public.clubs cl ON cl.id = c.club_id
        WHERE upper(c.code) = $1
          AND c.revoked_at IS NULL`,
      [code],
    );
    const row = codes[0];
    if (!row) throw new BadRequestException("invalid or revoked code");

    const existing = await this.postgres.query<
      Array<{ id: string; code_id: string; revoked_at: string | null }>
    >(
      `SELECT id::text AS id, code_id::text AS code_id, revoked_at::text
         FROM public.gamenet_devices
        WHERE device_id = $1
        ORDER BY bound_at DESC
        LIMIT 1`,
      [deviceId],
    );
    const current = existing[0];
    if (current && !current.revoked_at) {
      if (current.code_id === row.id) {
        await this.postgres.query(
          `UPDATE public.gamenet_devices
              SET last_seen_at = now(),
                  device_label = CASE
                    WHEN $2 <> '' THEN $2 ELSE device_label
                  END
            WHERE id = $1::uuid`,
          [current.id, deviceLabel],
        );
        const session = await this.ensureSession(
          user.steam_id,
          current.id,
          row.club_id,
        );
        return {
          success: true,
          already_bound: true,
          code_id: row.id,
          label: row.label,
          club_id: row.club_id,
          club_name: row.club_name,
          device_row_id: current.id,
          session,
        };
      }
      throw new BadRequestException(
        "this device is already bound to another code — revoke it first",
      );
    }

    const [countRow] = await this.postgres.query<
      Array<{ n: number }>
    >(
      `SELECT COUNT(*)::int AS n
         FROM public.gamenet_devices
        WHERE code_id = $1::uuid AND revoked_at IS NULL`,
      [row.id],
    );
    if (Number(countRow?.n || 0) >= row.max_devices) {
      throw new BadRequestException("device limit reached for this code");
    }

    const inserted = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.gamenet_devices
         (code_id, device_id, device_label, bound_by_steam_id)
       VALUES ($1::uuid, $2, $3, $4::bigint)
       RETURNING id::text AS id`,
      [row.id, deviceId, deviceLabel, user.steam_id],
    );
    const deviceRowId = inserted[0]?.id;
    if (!deviceRowId) throw new BadRequestException("could not bind device");

    const session = await this.ensureSession(
      user.steam_id,
      deviceRowId,
      row.club_id,
    );
    this.logger.log(
      `gamenet device bound code=${code} device=${deviceId.slice(0, 12)}… by=${user.steam_id}`,
    );
    return {
      success: true,
      already_bound: false,
      code_id: row.id,
      label: row.label,
      club_id: row.club_id,
      club_name: row.club_name,
      device_row_id: deviceRowId,
      session,
    };
  }

  public async heartbeat(
    user: User,
    input: { device_id?: string },
  ): Promise<{
    bound: boolean;
    active: boolean;
    label?: string;
    club_name?: string | null;
    club_id?: string | null;
    expires_at?: string;
    multiplier?: number;
  }> {
    const deviceId = String(input?.device_id || "").trim();
    if (deviceId.length < 8) {
      return { bound: false, active: false };
    }

    const devices = await this.postgres.query<
      Array<{
        id: string;
        label: string;
        club_id: string | null;
        club_name: string | null;
        code_revoked: string | null;
        device_revoked: string | null;
      }>
    >(
      `SELECT d.id::text AS id,
              c.label,
              c.club_id::text AS club_id,
              cl.name AS club_name,
              c.revoked_at::text AS code_revoked,
              d.revoked_at::text AS device_revoked
         FROM public.gamenet_devices d
         JOIN public.gamenet_codes c ON c.id = d.code_id
         LEFT JOIN public.clubs cl ON cl.id = c.club_id
        WHERE d.device_id = $1
        ORDER BY d.bound_at DESC
        LIMIT 1`,
      [deviceId],
    );
    const device = devices[0];
    if (!device || device.code_revoked || device.device_revoked) {
      return { bound: false, active: false };
    }

    await this.postgres.query(
      `UPDATE public.gamenet_devices SET last_seen_at = now() WHERE id = $1::uuid`,
      [device.id],
    );
    const session = await this.ensureSession(
      user.steam_id,
      device.id,
      device.club_id,
    );
    return {
      bound: true,
      active: true,
      label: device.label,
      club_id: device.club_id,
      club_name: device.club_name,
      expires_at: session.expires_at,
      multiplier: 2,
    };
  }

  public async status(deviceIdRaw: string): Promise<{
    bound: boolean;
    label?: string;
    club_name?: string | null;
  }> {
    const deviceId = String(deviceIdRaw || "").trim();
    if (deviceId.length < 8) return { bound: false };
    const rows = await this.postgres.query<
      Array<{ label: string; club_name: string | null }>
    >(
      `SELECT c.label, cl.name AS club_name
         FROM public.gamenet_devices d
         JOIN public.gamenet_codes c ON c.id = d.code_id
         LEFT JOIN public.clubs cl ON cl.id = c.club_id
        WHERE d.device_id = $1
          AND d.revoked_at IS NULL
          AND c.revoked_at IS NULL
        ORDER BY d.bound_at DESC
        LIMIT 1`,
      [deviceId],
    );
    const row = rows[0];
    if (!row) return { bound: false };
    return { bound: true, label: row.label, club_name: row.club_name };
  }

  /** Map steam_id → XP multiplier for currently active gamenet sessions. */
  public async multipliersFor(
    steamIds: string[],
  ): Promise<Map<string, number>> {
    const ids = [
      ...new Set(
        steamIds
          .map((id) => String(id || "").trim())
          .filter((id) => /^\d{5,20}$/.test(id)),
      ),
    ];
    const out = new Map<string, number>();
    if (!ids.length) return out;

    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT DISTINCT s.steam_id::text AS steam_id
         FROM public.gamenet_sessions s
         JOIN public.gamenet_devices d ON d.id = s.device_row_id
         JOIN public.gamenet_codes c ON c.id = d.code_id
        WHERE s.steam_id = ANY($1::bigint[])
          AND s.expires_at > now()
          AND d.revoked_at IS NULL
          AND c.revoked_at IS NULL`,
      [ids],
    );
    for (const row of rows) {
      out.set(row.steam_id, 2);
    }
    return out;
  }

  private async ensureSession(
    steamId: string,
    deviceRowId: string,
    clubId: string | null,
  ): Promise<{ id: string; expires_at: string }> {
    const expires = new Date(
      Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const existing = await this.postgres.query<
      Array<{ id: string; expires_at: string }>
    >(
      `SELECT id::text AS id, expires_at::text
         FROM public.gamenet_sessions
        WHERE device_row_id = $1::uuid
          AND steam_id = $2::bigint
          AND expires_at > now()
        ORDER BY expires_at DESC
        LIMIT 1`,
      [deviceRowId, steamId],
    );
    if (existing[0]) {
      const updated = await this.postgres.query<
        Array<{ id: string; expires_at: string }>
      >(
        `UPDATE public.gamenet_sessions
            SET expires_at = $2::timestamptz,
                last_seen_at = now(),
                club_id = $3::uuid
          WHERE id = $1::uuid
      RETURNING id::text AS id, expires_at::text`,
        [existing[0].id, expires, clubId],
      );
      return updated[0] || existing[0];
    }

    const inserted = await this.postgres.query<
      Array<{ id: string; expires_at: string }>
    >(
      `INSERT INTO public.gamenet_sessions
         (device_row_id, steam_id, club_id, expires_at)
       VALUES ($1::uuid, $2::bigint, $3::uuid, $4::timestamptz)
       RETURNING id::text AS id, expires_at::text`,
      [deviceRowId, steamId, clubId, expires],
    );
    if (!inserted[0]) throw new BadRequestException("could not start session");
    return inserted[0];
  }

  private generateCode(): string {
    const bytes = randomBytes(8);
    let out = "";
    for (let i = 0; i < 8; i++) {
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
  }

  private normalizeCode(raw: string): string {
    return String(raw || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 16);
  }

  private assertUuid(value: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      throw new BadRequestException("invalid id");
    }
  }

  public assertAdmin(user: User | undefined): User {
    if (!user?.steam_id) {
      throw new ForbiddenException("Authentication required");
    }
    if (user.role !== "administrator") {
      throw new ForbiddenException("Administrator access required");
    }
    return user;
  }
}
