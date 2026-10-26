import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomBytes } from "crypto";
import { HasuraService } from "../hasura/hasura.service";
import { CacheService } from "../cache/cache.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { SteamConfig } from "../configs/types/SteamConfig";
import { SteamMatchHistoryQueues } from "../steam-match-history/enums/SteamMatchHistoryQueues";
import { SteamBansService } from "../steam-match-history/steam-bans.service";
import { FaceitQueues } from "../faceit/enums/FaceitQueues";
import { e_player_roles_enum } from "../../generated";
import { User } from "./types/User";

const DESKTOP_TOKEN_PREFIX = "auth:steam-desktop:";
const DESKTOP_TOKEN_TTL_SEC = 60;

type SteamTicketParams = {
  result?: string;
  steamid?: string;
  ownersteamid?: string;
  vacbanned?: boolean;
  publisherbanned?: boolean;
};

@Injectable()
export class SteamAuthService {
  /**
   * Ticket app id must match the desktop Steamworks Init app id.
   * Default 480 (Spacewar) works with a normal Steam Web API key; 730 only
   * works with a publisher key that owns CS2.
   */
  private readonly appId = Number(process.env.STEAM_AUTH_APP_ID || 480);

  constructor(
    private readonly config: ConfigService,
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly redisManager: RedisManagerService,
    private readonly logger: Logger,
    @InjectQueue(SteamMatchHistoryQueues.PollSteamMatchHistoryForUser)
    private readonly pollQueue: Queue,
    @InjectQueue(SteamMatchHistoryQueues.CheckSteamBans)
    private readonly steamBansQueue: Queue,
    @InjectQueue(FaceitQueues.RefreshFaceitRanks)
    private readonly faceitRanksQueue: Queue,
  ) {}

  /**
   * Validate a Steamworks auth session ticket, upsert the player (register if
   * new), and return a short-lived one-time token the desktop WebView exchanges
   * for a normal express-session cookie.
   */
  async issueDesktopLoginToken(ticketHex: string): Promise<{ token: string; steam_id: string }> {
    const steamId = await this.validateAuthTicket(ticketHex);
    const profile = await this.fetchPlayerSummary(steamId);
    const user = await this.upsertPlayerFromSteam({
      steamId,
      name: profile?.personaname || `Player ${steamId.slice(-4)}`,
      profileUrl:
        profile?.profileurl || `https://steamcommunity.com/profiles/${steamId}`,
      avatarUrl: profile?.avatarfull || profile?.avatarmedium || "",
    });

    this.fireRefreshes(String(user.steam_id));

    const token = randomBytes(32).toString("hex");
    await this.cache.put(
      `${DESKTOP_TOKEN_PREFIX}${token}`,
      user,
      DESKTOP_TOKEN_TTL_SEC,
    );

    return { token, steam_id: String(user.steam_id) };
  }

  async consumeDesktopLoginToken(token: string): Promise<User> {
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
      throw new BadRequestException("invalid token");
    }
    const key = `${DESKTOP_TOKEN_PREFIX}${token}`;
    const user = (await this.cache.get(key)) as User | undefined;
    await this.cache.forget(key);
    if (!user?.steam_id) {
      throw new UnauthorizedException("token expired or invalid");
    }
    return user;
  }

  async upsertPlayerFromSteam(input: {
    steamId: string;
    name: string;
    profileUrl: string;
    avatarUrl: string;
  }): Promise<User> {
    let role: e_player_roles_enum = "user";
    if (!(await this.cache.has("admin-check"))) {
      const { players } = await this.hasura.query({
        players: {
          __args: { limit: 1 },
          __typename: true,
        },
      });
      if (players.length === 0) {
        role = "administrator";
      }
      await this.cache.put("admin-check", true);
    }

    const { insert_players_one } = await this.hasura.mutation({
      insert_players_one: {
        __args: {
          object: {
            role,
            steam_id: input.steamId,
            name: input.name,
            profile_url: input.profileUrl,
            avatar_url: input.avatarUrl,
            last_sign_in_at: new Date(),
          },
          on_conflict: {
            constraint: "players_steam_id_key",
            update_columns: ["avatar_url", "profile_url", "last_sign_in_at"],
          },
        },
        name: true,
        role: true,
        steam_id: true,
        profile_url: true,
        avatar_url: true,
        discord_id: true,
        language: true,
        last_sign_in_at: true,
      },
    });

    return insert_players_one as User;
  }

  fireRefreshes(steamId: string): void {
    void this.pollQueue
      .add(
        "PollSteamMatchHistoryForUser",
        { steamId },
        {
          jobId: `poll-steam-match-history.${steamId}`,
          removeOnComplete: true,
          removeOnFail: true,
        },
      )
      .catch((err) => {
        this.logger.error(
          `on-login match-history poll enqueue failed for ${steamId}: ${(err as Error)?.message ?? err}`,
        );
      });

    void SteamBansService.enqueueChecks(
      this.redisManager.getConnection(),
      this.steamBansQueue,
      [steamId],
    ).catch((err) => {
      this.logger.error(
        `on-login steam-bans enqueue failed for ${steamId}: ${(err as Error)?.message ?? err}`,
      );
    });

    void this.faceitRanksQueue
      .add(
        "RefreshFaceitRanks",
        { steamIds: [steamId], force: true },
        {
          jobId: `faceit-rank-login.${steamId}`,
          removeOnComplete: 20,
          removeOnFail: 20,
        },
      )
      .catch((err) => {
        this.logger.warn(
          `on-login faceit refresh enqueue failed for ${steamId}: ${
            (err as Error)?.message ?? err
          }`,
        );
      });
  }

  private steamApiKey(): string {
    const key = this.config.get<SteamConfig>("steam")?.steamApiKey;
    if (!key) {
      throw new UnauthorizedException("steam api key not configured");
    }
    return key;
  }

  private async validateAuthTicket(ticketHex: string): Promise<string> {
    const cleaned = (ticketHex || "").trim().replace(/^0x/i, "").replace(/\s+/g, "");
    if (!/^[a-fA-F0-9]{32,}$/.test(cleaned)) {
      throw new BadRequestException("invalid steam ticket");
    }

    const url = new URL(
      "https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/",
    );
    url.searchParams.set("key", this.steamApiKey());
    url.searchParams.set("appid", String(this.appId));
    url.searchParams.set("ticket", cleaned);

    const res = await fetch(url);
    if (!res.ok) {
      this.logger.warn(`AuthenticateUserTicket http ${res.status}`);
      throw new UnauthorizedException("steam ticket validation failed");
    }

    const body = (await res.json()) as {
      response?: { params?: SteamTicketParams; error?: { errorcode?: number; errordesc?: string } };
    };

    const params = body.response?.params;
    if (!params || params.result !== "OK" || !params.steamid) {
      const err = body.response?.error;
      this.logger.warn(
        `AuthenticateUserTicket rejected: ${err?.errordesc || params?.result || "unknown"}`,
      );
      throw new UnauthorizedException("invalid or expired steam ticket");
    }

    if (params.publisherbanned) {
      throw new UnauthorizedException("steam account banned");
    }

    return params.steamid;
  }

  private async fetchPlayerSummary(steamId: string): Promise<{
    personaname?: string;
    profileurl?: string;
    avatarfull?: string;
    avatarmedium?: string;
  } | null> {
    try {
      const url = new URL(
        "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/",
      );
      url.searchParams.set("key", this.steamApiKey());
      url.searchParams.set("steamids", steamId);
      const res = await fetch(url);
      if (!res.ok) return null;
      const body = (await res.json()) as {
        response?: { players?: Array<Record<string, string>> };
      };
      return body.response?.players?.[0] || null;
    } catch (err) {
      this.logger.warn(
        `GetPlayerSummaries failed for ${steamId}: ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
  }
}
