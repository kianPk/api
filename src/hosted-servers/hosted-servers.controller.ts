import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { HostedServersService } from "./hosted-servers.service";

@Controller("hosted-servers")
export class HostedServersController {
  constructor(private readonly hostedServers: HostedServersService) {}

  @Get("overview")
  public async overview() {
    return this.hostedServers.getPublicOverview();
  }

  @Get("mine")
  public async mine(@Req() request: Request) {
    const user = this.requireUser(request);
    return this.hostedServers.listForOwner(user.steam_id);
  }

  @Get("admin/list")
  public async adminList(@Req() request: Request) {
    this.requireAdmin(request);
    return this.hostedServers.listAll();
  }

  @Get("admin/settings")
  public async adminSettings(@Req() request: Request) {
    this.requireAdmin(request);
    return this.hostedServers.getAdminSettings();
  }

  @Post("admin/settings")
  public async adminUpdateSettings(
    @Req() request: Request,
    @Body()
    body: {
      enabled?: boolean;
      max_active?: number;
      reserve_match_slots?: number;
      grace_days?: number;
      gslt_pool?: string;
      steam_api_key?: string;
    },
  ) {
    this.requireAdmin(request);
    return this.hostedServers.updateSettings(body || {});
  }

  @Get("admin/plans")
  public async adminPlans(@Req() request: Request) {
    this.requireAdmin(request);
    return this.hostedServers.listAdminPlans();
  }

  @Post("admin/plans/:id/active")
  public async adminPlanActive(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: { active?: boolean },
  ) {
    this.requireAdmin(request);
    return this.hostedServers.adminSetPlanActive(id, Boolean(body?.active));
  }

  @Post("admin/plans/:id/delete")
  public async adminPlanDelete(
    @Req() request: Request,
    @Param("id") id: string,
  ) {
    this.requireAdmin(request);
    return this.hostedServers.adminDeletePlan(id);
  }

  @Post("admin/:id/extend")
  public async adminExtend(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: { days?: number },
  ) {
    this.requireAdmin(request);
    return this.hostedServers.adminExtend(id, Number(body?.days));
  }

  @Post("admin/:id/suspend")
  public async adminSuspend(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: { suspended?: boolean },
  ) {
    this.requireAdmin(request);
    return this.hostedServers.adminSuspend(id, Boolean(body?.suspended));
  }

  @Post("admin/:id/delete")
  public async adminDelete(@Req() request: Request, @Param("id") id: string) {
    this.requireAdmin(request);
    return this.hostedServers.adminDelete(id);
  }

  @Post("admin/:id/purge")
  public async adminPurge(@Req() request: Request, @Param("id") id: string) {
    this.requireAdmin(request);
    return this.hostedServers.adminPurge(id);
  }

  @Post("admin/:id/retry")
  public async adminRetry(@Req() request: Request, @Param("id") id: string) {
    this.requireAdmin(request);
    return this.hostedServers.retryProvision(id);
  }

  @Post("admin/:id/gslt")
  public async adminGslt(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: { token?: string },
  ) {
    this.requireAdmin(request);
    return this.hostedServers.adminSetGslt(id, String(body?.token || ""));
  }

  @Get(":id")
  public async get(@Req() request: Request, @Param("id") id: string) {
    const user = this.requireUser(request);
    const hosted = await this.hostedServers.requireAccess(id, user);
    return this.hostedServers.getHostedView(hosted.id);
  }

  @Post(":id/settings")
  public async settings(
    @Req() request: Request,
    @Param("id") id: string,
    @Body()
    body: { label?: string; connect_password?: string | null; type?: string },
  ) {
    const user = this.requireUser(request);
    const hosted = await this.hostedServers.requireAccess(id, user);
    return this.hostedServers.updateServerSettings(hosted, {
      label: body?.label,
      connect_password: body?.connect_password,
      type: body?.type,
    });
  }

  @Post(":id/restart")
  public async restart(@Req() request: Request, @Param("id") id: string) {
    const user = this.requireUser(request);
    const hosted = await this.hostedServers.requireAccess(id, user);
    return this.hostedServers.restart(hosted);
  }

  @Post(":id/power")
  public async power(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: { on?: boolean },
  ) {
    const user = this.requireUser(request);
    const hosted = await this.hostedServers.requireAccess(id, user);
    return this.hostedServers.setPower(hosted, Boolean(body?.on));
  }

  @Post(":id/rcon")
  public async rcon(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: { command?: string },
  ) {
    const user = this.requireUser(request);
    const hosted = await this.hostedServers.requireAccess(id, user);
    return this.hostedServers.sendRcon(hosted, String(body?.command || ""));
  }

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    return user;
  }

  private requireAdmin(request: Request) {
    const user = this.requireUser(request);
    if (user.role !== "administrator") {
      throw new ForbiddenException("Administrator access required");
    }
  }
}
