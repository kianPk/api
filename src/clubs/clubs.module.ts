import { Logger, Module, forwardRef } from "@nestjs/common";
import { ClubsController } from "./clubs.controller";
import { ClubsService } from "./clubs.service";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { SystemModule } from "../system/system.module";
import { MatchesModule } from "../matches/matches.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [
    HasuraModule,
    PostgresModule,
    SystemModule,
    forwardRef(() => MatchesModule),
  ],
  controllers: [ClubsController],
  providers: [ClubsService, loggerFactory()],
  exports: [ClubsService],
})
export class ClubsModule {}
