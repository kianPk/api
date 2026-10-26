import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
  Res,
  Logger,
  BadRequestException,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { SteamGuard } from "./strategies/SteamGuard";
import { HasuraAction } from "../hasura/hasura.controller";
import { DiscordGuard } from "./strategies/DiscordGuard";
import { ThrottlerBehindProxyGuard } from "./strategies/ThrottlerBehindProxyGuard";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { ApiKeys } from "./ApiKeys";
import { User } from "./types/User";
import { SocketsService } from "src/sockets/sockets.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { FaceitQueues } from "../faceit/enums/FaceitQueues";
import { SteamAuthService } from "./steam-auth.service";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../configs/types/AppConfig";

const AUTH_THROTTLE = { default: { limit: 10, ttl: 60 * 1000 } };
const DESKTOP_THROTTLE = { default: { limit: 20, ttl: 60 * 1000 } };

@Controller("auth")
export class AuthController {
  constructor(
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly redis: RedisManagerService,
    private readonly apiKeys: ApiKeys,
    private readonly steamAuth: SteamAuthService,
    private readonly config: ConfigService,
    @InjectQueue(FaceitQueues.RefreshFaceitRanks)
    private readonly faceitRanksQueue: Queue,
    private readonly logger: Logger,
  ) {}

  @UseGuards(ThrottlerBehindProxyGuard, SteamGuard)
  @Throttle(AUTH_THROTTLE)
  @Get("steam")
  public async steamLogin(@Req() request: Request, @Res() res: Response) {
    return res.redirect(request.session.redirect || "/");
  }

  @UseGuards(ThrottlerBehindProxyGuard, SteamGuard)
  @Throttle(AUTH_THROTTLE)
  @Get("steam/callback")
  public steamCallback(@Req() request: Request, @Res() res: Response) {
    return res.redirect(request.session.redirect || "/");
  }

  /**
   * Desktop client: prove local Steam identity with a session ticket.
   * Returns a one-time token; WebView then hits GET /auth/steam/desktop?token=…
   * so the session cookie is set by the browser (same as OpenID).
   */
  @UseGuards(ThrottlerBehindProxyGuard)
  @Throttle(DESKTOP_THROTTLE)
  @Post("steam/ticket")
  public async steamTicketLogin(
    @Body() body: { ticket?: string },
  ): Promise<{ token: string; steam_id: string }> {
    const ticket = typeof body?.ticket === "string" ? body.ticket : "";
    if (!ticket) {
      throw new BadRequestException("ticket required");
    }
    return this.steamAuth.issueDesktopLoginToken(ticket);
  }

  @UseGuards(ThrottlerBehindProxyGuard)
  @Throttle(DESKTOP_THROTTLE)
  @Get("steam/desktop")
  public async steamDesktopExchange(
    @Req() request: Request,
    @Res() res: Response,
  ) {
    const token =
      typeof request.query.token === "string" ? request.query.token : "";
    const redirectRaw =
      typeof request.query.redirect === "string"
        ? request.query.redirect
        : "/launcher?desktop=1";

    const webDomain = this.config.get<AppConfig>("app").webDomain;
    const fallback = `${webDomain}/launcher?desktop=1`;
    let redirect = fallback;
    if (redirectRaw.startsWith("/") && !redirectRaw.startsWith("//")) {
      redirect = `${webDomain}${redirectRaw}`;
    } else if (redirectRaw.startsWith(webDomain)) {
      redirect = redirectRaw;
    }

    try {
      const user = await this.steamAuth.consumeDesktopLoginToken(token);
      await new Promise<void>((resolve, reject) => {
        request.login(user, (err) => (err ? reject(err) : resolve()));
      });
      return res.redirect(redirect);
    } catch (err) {
      this.logger.warn(
        `desktop steam exchange failed: ${(err as Error)?.message ?? err}`,
      );
      return res.redirect(
        `${webDomain}/login?error=steam_desktop&redirect=${encodeURIComponent("/launcher?desktop=1")}`,
      );
    }
  }

  @UseGuards(ThrottlerBehindProxyGuard, DiscordGuard)
  @Throttle(AUTH_THROTTLE)
  @Get("discord")
  public async linkDiscord(@Req() request: Request, @Res() res: Response) {
    return res.redirect(request.session.redirect || "/");
  }

  @UseGuards(ThrottlerBehindProxyGuard, DiscordGuard)
  @Throttle(AUTH_THROTTLE)
  @Get("discord/callback")
  public linkDiscordCallback(@Req() request: Request, @Res() res: Response) {
    return res.redirect(request.session.redirect || "/");
  }

  @HasuraAction()
  public async me(@Req() request: Request) {
    const user = request.user;

    user.name = await this.cache.get(
      HasuraService.PLAYER_NAME_CACHE_KEY(request.user.steam_id),
      request.user.name,
    );

    user.role = await this.cache.get(
      HasuraService.PLAYER_ROLE_CACHE_KEY(request.user.steam_id),
    );

    const lastSignInKey = HasuraService.PLAYER_LAST_SIGN_IN_CACHE_KEY(
      request.user.steam_id,
    );

    if (!(await this.cache.has(lastSignInKey))) {
      const now = new Date();
      await this.hasura.mutation({
        update_players_by_pk: {
          __args: {
            pk_columns: { steam_id: request.user.steam_id },
            _set: { last_sign_in_at: now },
          },
          __typename: true,
        },
      });
      await this.cache.put(lastSignInKey, true, 60 * 60);
      user.last_sign_in_at = now;

      // Session return: refresh FACEIT level from FACEIT API in the background.
      const steamId = String(request.user.steam_id);
      void this.faceitRanksQueue
        .add(
          "RefreshFaceitRanks",
          { steamIds: [steamId], force: true },
          {
            jobId: `faceit-rank-me.${steamId}`,
            removeOnComplete: 20,
            removeOnFail: 20,
          },
        )
        .catch((err) => {
          this.logger.warn(
            `me() faceit refresh enqueue failed for ${steamId}: ${
              (err as Error)?.message ?? err
            }`,
          );
        });
    }

    return user;
  }

  @HasuraAction()
  public async unlinkDiscord(@Req() request: Request) {
    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: {
            steam_id: request.user.steam_id,
          },
          _set: {
            discord_id: null,
          },
        },
        __typename: true,
      },
    });

    request.user.discord_id = null;
    request.session.save();

    return { success: true };
  }

  @HasuraAction()
  public async logout(@Req() request: Request) {
    if (request.session) {
      await this.redis
        .getConnection()
        .del(SocketsService.GET_PLAYER_CLIENT_LATENCY_TEST(request.session.id));

      request.session.destroy((err) => {
        if (err) {
          this.logger.error("Error destroying session:", err);
        }
      });
    }
    return { success: true };
  }

  @HasuraAction()
  public async createApiKey(data: {
    user: User;
    label: string;
  }): Promise<{ key: string }> {
    const { label } = data;

    if (!label) {
      throw new BadRequestException("Label is required");
    }

    return {
      key: await this.apiKeys.createApiKey(label, data.user.steam_id),
    };
  }
}
