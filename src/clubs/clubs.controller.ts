import { Controller, Get } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { ClubsService } from "./clubs.service";

@Controller("clubs")
export class ClubsController {
  constructor(private readonly clubs: ClubsService) {}

  // Read by dedicated-server plugins (no auth). Steam IDs are strings.
  @Get("clan-tags")
  public async clanTags() {
    return this.clubs.clanTagsPayload();
  }

  @HasuraAction()
  public async createClub(data: {
    user: User;
    name: string;
    short_name?: string | null;
    description: string;
    join_mode: string;
  }) {
    return this.clubs.createClub(String(data.user.steam_id), {
      name: data.name,
      short_name: data.short_name,
      description: data.description,
      join_mode: data.join_mode,
    });
  }

  @HasuraAction()
  public async transferClub(data: {
    user: User;
    club_id: string;
    steam_id: string;
  }) {
    return this.clubs.transferClub(
      data.club_id,
      String(data.user.steam_id),
      String(data.steam_id),
    );
  }

  @HasuraAction()
  public async createClubOfficialTeam(data: { user: User; club_id: string }) {
    return this.clubs.createClubOfficialTeam(
      data.club_id,
      String(data.user.steam_id),
    );
  }

  @HasuraAction()
  public async leaveClub(data: { user: User; club_id: string }) {
    return this.clubs.leaveClub(data.club_id, String(data.user.steam_id));
  }

  @HasuraAction()
  public async grantPlayerTag(data: {
    user: User;
    steam_id: string;
    tag: string;
  }) {
    return this.clubs.grantPlayerTag(
      String(data.user.steam_id),
      String(data.steam_id),
      data.tag,
    );
  }

  @HasuraAction()
  public async revokePlayerTag(data: {
    user: User;
    steam_id: string;
    tag: string;
  }) {
    return this.clubs.revokePlayerTag(
      String(data.user.steam_id),
      String(data.steam_id),
      data.tag,
    );
  }

  @HasuraAction()
  public async acceptClubInvite(data: { user: User; invite_id: string }) {
    return this.clubs.acceptClubInvite(data.invite_id, String(data.user.steam_id));
  }

  @HasuraAction()
  public async redeemClubInviteLink(data: { user: User; code: string }) {
    return this.clubs.redeemClubInviteLink(data.code, String(data.user.steam_id));
  }

  @HasuraAction()
  public async createClubInviteLink(data: {
    user: User;
    club_id: string;
    max_uses?: number | null;
    expires_hours?: number | null;
    bypass_requirements?: boolean;
  }) {
    return this.clubs.createClubInviteLink(
      data.club_id,
      String(data.user.steam_id),
      {
        max_uses: data.max_uses,
        expires_hours: data.expires_hours,
        bypass_requirements: data.bypass_requirements,
      },
    );
  }

  @HasuraAction()
  public async reviewClubJoinRequest(data: {
    user: User;
    request_id: string;
    accept: boolean;
  }) {
    return this.clubs.reviewClubJoinRequest(
      data.request_id,
      String(data.user.steam_id),
      !!data.accept,
    );
  }

  @HasuraAction()
  public async joinClubOpen(data: { user: User; club_id: string }) {
    return this.clubs.joinClubOpen(data.club_id, String(data.user.steam_id));
  }

  @HasuraAction()
  public async setPrimaryClub(data: { user: User; club_id: string }) {
    return this.clubs.setPrimaryClub(data.club_id, String(data.user.steam_id));
  }

  @HasuraAction()
  public async joinClubQueue(data: { user: User; queue_id: string }) {
    return this.clubs.joinClubQueue(data.queue_id, String(data.user.steam_id));
  }

  @HasuraAction()
  public async leaveClubQueue(data: { user: User; queue_id: string }) {
    return this.clubs.leaveClubQueue(data.queue_id, String(data.user.steam_id));
  }

  @HasuraAction()
  public async registerClubClash(data: {
    user: User;
    event_id: string;
    club_id: string;
  }) {
    return this.clubs.registerClubClash(
      data.event_id,
      data.club_id,
      String(data.user.steam_id),
    );
  }

  @HasuraAction()
  public async addClubPartyGuest(data: {
    user: User;
    party_id: string;
    steam_id: string;
  }) {
    return this.clubs.addClubPartyGuest(
      data.party_id,
      String(data.user.steam_id),
      String(data.steam_id),
    );
  }
}
