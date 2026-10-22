import { Module } from "@nestjs/common";
import { ClubsController } from "./clubs.controller";
import { ClubServersHttpController } from "./club-servers.http.controller";
import { ClubsService } from "./clubs.service";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { YpointModule } from "../ypoint/ypoint.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [HasuraModule, PostgresModule, YpointModule],
  controllers: [ClubsController, ClubServersHttpController],
  providers: [ClubsService, loggerFactory()],
  exports: [ClubsService],
})
export class ClubsModule {}
