import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { ClubsService } from "./clubs.service";

@Controller("clubs")
export class ClubsController {
  constructor(private readonly clubs: ClubsService) {}

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
