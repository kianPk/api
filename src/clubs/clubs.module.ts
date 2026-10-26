import { Module, forwardRef } from "@nestjs/common";
import { ClubsController } from "./clubs.controller";
import { ClubServersHttpController } from "./club-servers.http.controller";
import { ClubsService } from "./clubs.service";
import { ClubShopService } from "./club-shop.service";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { YpointModule } from "../ypoint/ypoint.module";
import { IrrModule } from "../irr/irr.module";
import { RconModule } from "../rcon/rcon.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [
    HasuraModule,
    PostgresModule,
    YpointModule,
    IrrModule,
    forwardRef(() => RconModule),
  ],
  controllers: [ClubsController, ClubServersHttpController],
  providers: [ClubsService, ClubShopService, loggerFactory()],
  exports: [ClubsService, ClubShopService],
})
export class ClubsModule {}
