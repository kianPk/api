import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { ServersSectionService } from "./servers-section.service";
import {
  SERVER_SECTION_MODES,
  isServerSectionMode,
} from "../game-plugins/server-section-modes";

// Under /hosted-servers because that prefix is already routed to the api by
// the public ingress.
@Controller("hosted-servers")
export class ServersSectionController {
  constructor(private readonly serversSection: ServersSectionService) {}

  // Read by each mode's plugin on every map start, and by the Servers page.
  @Get("section-maps/:mode")
  public async sectionMaps(
    @Param("mode") mode: string,
    @Query("server_id") serverId?: string,
  ) {
    if (!isServerSectionMode(mode)) {
      throw new NotFoundException();
    }
    const section = SERVER_SECTION_MODES[mode];
    if (serverId) {
      const clubMaps = await this.serversSection.mapsForServer(
        serverId,
        section,
      );
      if (clubMaps?.length) return { maps: clubMaps };
    }
    return {
      maps: await this.serversSection.maps(section),
    };
  }
}
