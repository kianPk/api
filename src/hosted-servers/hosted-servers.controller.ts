import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
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
      slot_price_irr?: number;
      slot_price_ypoint?: number;
      max_slots?: number;
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

  @Get("plugin/state")
  public async pluginState(
    @Req() request: Request,
    @Query("server_id") serverId: string,
  ) {
    return this.hostedServers.pluginState(
      String(serverId || ""),
      request.headers.authorization,
    );
  }

  @Post("plugin/ban")
  public async pluginBan(
    @Req() request: Request,
    @Body()
    body: {
      server_id?: string;
      steam_id?: string;
      name?: string;
      reason?: string;
      minutes?: number;
      admin_steam_id?: string;
      admin_name?: string;
    },
  ) {
    return this.hostedServers.pluginBan(
      request.headers.authorization,
      body || {},
    );
  }

  @Post("plugin/unban")
  public async pluginUnban(
    @Req() request: Request,
    @Body()
    body: { server_id?: string; steam_id?: string; admin_steam_id?: string },
  ) {
    return this.hostedServers.pluginUnban(
      request.headers.authorization,
      body || {},
    );
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

  @Get(":id/slots-quote")
  public async slotsQuote(
    @Req() request: Request,
    @Param("id") id: string,
    @Query("count") count: string,
  ) {
    const user = this.requireUser(request);
    const hosted = await this.hostedServers.requireAccess(id, user);
    return this.hostedServers.quoteExtraSlots(hosted, Number(count));
  }

  @Get(":id/admins")
  public async admins(@Req() request: Request, @Param("id") id: string) {
    const user = this.requireUser(request);
    const hosted = await this.hostedServers.requireAccess(id, user);
    return this.hostedServers.listAdmins(hosted);
  }

  @Post(":id/admins")
  public async addAdmin(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: { steam_id?: string },
  ) {
    const user = this.requireUser(request);
    const hosted = await this.hostedServers.requireAccess(id, user);
    return this.hostedServers.addAdmin(hosted, body?.steam_id, user);
  }

  @Post(":id/admins/:steamId/delete")
  public async removeAdmin(
    @Req() request: Request,
    @Param("id") id: string,
    @Param("steamId") steamId: string,
  ) {
    const user = this.requireUser(request);
    const hosted = await this.hostedServers.requireAccess(id, user);
    return this.hostedServers.removeAdmin(hosted, steamId);
  }

  @Get(":id/bans")
  public async bans(@Req() request: Request, @Param("id") id: string) {
    const user = this.requireUser(request);
    const hosted = await this.hostedServers.requireAccess(id, user);
    return this.hostedServers.listBans(hosted);
  }

  @Post(":id/bans/:steamId/delete")
  public async removeBan(
    @Req() request: Request,
    @Param("id") id: string,
    @Param("steamId") steamId: string,
  ) {
    const user = this.requireUser(request);
    const hosted = await this.hostedServers.requireAccess(id, user);
    return this.hostedServers.removeBan(hosted, steamId);
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
