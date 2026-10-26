import { Module, forwardRef } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { PassportModule } from "@nestjs/passport";
import { SteamStrategy } from "./strategies/SteamStrategy";
import { HasuraModule } from "../hasura/hasura.module";
import { SteamSerializer } from "./strategies/SteamSerializer";
import { DiscordStrategy } from "./strategies/DiscordStrategy";
import { loggerFactory } from "../utilities/LoggerFactory";
import { CacheModule } from "../cache/cache.module";
import { RedisModule } from "../redis/redis.module";
import { ApiKeys } from "./ApiKeys";
import { ApiKeyGuard } from "./strategies/ApiKeyGuard";
import { BullModule } from "@nestjs/bullmq";
import { SteamMatchHistoryQueues } from "../steam-match-history/enums/SteamMatchHistoryQueues";
import { FaceitQueues } from "../faceit/enums/FaceitQueues";
import { SteamAuthService } from "./steam-auth.service";

@Module({
  imports: [
    PassportModule.register({
      session: true,
    }),
    forwardRef(() => HasuraModule),
    CacheModule,
    RedisModule,
    BullModule.registerQueue(
      { name: SteamMatchHistoryQueues.CheckSteamBans },
      { name: SteamMatchHistoryQueues.PollSteamMatchHistoryForUser },
      // Queue only — do not import FaceitModule (Auth↔Hasura↔Faceit cycle).
      { name: FaceitQueues.RefreshFaceitRanks },
    ),
  ],
  providers: [
    ApiKeys,
    ApiKeyGuard,
    SteamAuthService,
    SteamStrategy,
    DiscordStrategy,
    SteamSerializer,
    loggerFactory(),
  ],
  exports: [ApiKeys, ApiKeyGuard, SteamAuthService],
  controllers: [AuthController],
})
export class AuthModule {}
