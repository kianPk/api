import { Module } from "@nestjs/common";
import { ClubsController } from "./clubs.controller";
import { ClubsService } from "./clubs.service";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { YpointModule } from "../ypoint/ypoint.module";
import { DedicatedServersModule } from "../dedicated-servers/dedicated-servers.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [HasuraModule, PostgresModule, YpointModule, DedicatedServersModule],
  controllers: [ClubsController],
  providers: [ClubsService, loggerFactory()],
  exports: [ClubsService],
})
export class ClubsModule {}
