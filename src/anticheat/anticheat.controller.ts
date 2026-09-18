import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { AnticheatService, AcChecks } from "./anticheat.service";

@Controller("plugins/ac")
export class AnticheatController {
  constructor(private readonly ac: AnticheatService) {}

  @Get("requirements")
  public requirements() {
    return this.ac.getRequirements();
  }

  /** Launcher: start browser Steam login link. */
  @Post("device/begin")
  public beginDevice() {
    return this.ac.beginLauncherLogin();
  }

  /** Website (session): approve launcher login with logged-in Steam. */
  @Post("device/approve")
  public async approveDevice(
    @Req() request: Request,
    @Body() body: { code?: string },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Login required");
    }
    return this.ac.approveLauncherLogin(String(user.steam_id), String(body?.code || ""));
  }

  /** Launcher: poll until website approved. */
  @Post("device/poll")
  public pollDevice(@Body() body: { code?: string; label?: string }) {
    return this.ac.pollLauncherLogin(String(body?.code || ""), body?.label);
  }

  /** Website (session cookie): create a 6-char code for the launcher. */
  @Post("pair/start")
  public async pairStart(@Req() request: Request) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Login required");
    }
    return this.ac.startPairing(String(user.steam_id));
  }

  /** Launcher: exchange code for a long-lived device token. */
  @Post("pair/claim")
  public async pairClaim(
    @Body() body: { code?: string; label?: string },
  ) {
    return this.ac.claimPairing(String(body?.code || ""), body?.label);
  }

  /** Launcher: profile for the paired device token. */
  @Get("me")
  public async me(@Headers("authorization") authorization: string | undefined) {
    const token = this.bearer(authorization);
    return this.ac.profileForDevice(token);
  }

  /** Launcher: submit hardware checks. Header: Authorization: Bearer <device_token> */
  @Post("attest")
  public async attest(
    @Headers("authorization") authorization: string | undefined,
    @Body()
    body: AcChecks & {
      os_version?: string;
      hardware_hash?: string;
      cheat_clean?: boolean;
    },
  ) {
    const token = this.bearer(authorization);
    return this.ac.submitAttestation(token, body || ({} as AcChecks));
  }

  /** Launcher closing / logout — expire attestation and kick from live match (no ban). */
  @Post("disconnect")
  public async disconnect(
    @Headers("authorization") authorization: string | undefined,
  ) {
    const token = this.bearer(authorization);
    return this.ac.disconnectDevice(token);
  }

  /** Public: latest Windows launcher version + download URL (auto-update). */
  @Get("launcher")
  @Header("Cache-Control", "no-store, no-cache, must-revalidate")
  public launcher() {
    return this.ac.getLauncherRelease();
  }

  /**
   * Game server (Bearer SERVER_API_PASSWORD): may this steam join / stay?
   * Used by YGuardAC plugin to kick IP-connects without a live launcher.
   */
  @Get("server/check")
  @Header("Cache-Control", "no-store")
  public serverCheck(
    @Headers("authorization") authorization: string | undefined,
    @Query("steam_id") steamId: string,
    @Query("server_id") serverId: string,
  ) {
    return this.ac.checkPlayerForServer(serverId, steamId, authorization);
  }

  /** Launcher: report local cheat signature hits → platform ban; clean → unban. */
  @Post("report")
  public async report(
    @Headers("authorization") authorization: string | undefined,
    @Body()
    body: {
      clean?: boolean;
      hits?: Array<{
        signature?: string;
        path?: string;
        process_name?: string;
        details?: Record<string, unknown>;
      }>;
    },
  ) {
    const token = this.bearer(authorization);
    return this.ac.reportCheatHits(token, body?.hits || [], {
      clean: !!body?.clean,
    });
  }

  /** Website: am I allowed to queue? */
  @Get("status")
  public async status(@Req() request: Request) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Login required");
    }
    return this.ac.statusForPlayer(String(user.steam_id));
  }

  private bearer(authorization?: string): string {
    if (!authorization?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Bearer device token required");
    }
    return authorization.slice("Bearer ".length).trim();
  }
}
