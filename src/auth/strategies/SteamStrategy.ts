import { Injectable, Logger } from "@nestjs/common";
import { Strategy as _SteamStrategy } from "passport-steam";
import { PassportStrategy } from "@nestjs/passport";
import { DoneCallback } from "passport";
import { AppConfig } from "../../configs/types/AppConfig";
import { ConfigService } from "@nestjs/config";
import { SteamConfig } from "../../configs/types/SteamConfig";
import { SteamAuthService } from "../steam-auth.service";

interface SteamProfile {
  provider: string;
  _json: {
    steamid: string;
    communityvisibilitystate: number;
    profilestate: number;
    personaname: string;
    profileurl: string;
    avatar: string;
    avatarmedium: string;
    avatarfull: string;
    avatarhash: string;
    lastlogoff: number;
    personastate: number;
    primaryclanid: string;
    timecreated: number;
    personastateflags: number;
  };
  id: string;
  displayName: string;
  photos: { value: string }[];
}

@Injectable()
export class SteamStrategy extends PassportStrategy(_SteamStrategy) {
  constructor(
    readonly config: ConfigService,
    private readonly steamAuth: SteamAuthService,
    private readonly logger: Logger,
  ) {
    const webDomain = config.get<AppConfig>("app").webDomain;

    super({
      realm: webDomain,
      apiKey: config.get<SteamConfig>("steam").steamApiKey,
      returnURL: `${webDomain}/auth/steam/callback`,
    });
  }

  async validate(
    identifier: string,
    profile: SteamProfile,
    done: DoneCallback,
  ): Promise<void> {
    try {
      const user = await this.steamAuth.upsertPlayerFromSteam({
        steamId: profile._json.steamid,
        name: profile._json.personaname,
        profileUrl: profile._json.profileurl,
        avatarUrl: profile._json.avatarfull,
      });
      this.steamAuth.fireRefreshes(profile._json.steamid);
      done(null, user);
    } catch (err) {
      this.logger.error(
        `steam openid upsert failed: ${(err as Error)?.message ?? err}`,
      );
      done(err as Error);
    }
  }
}
