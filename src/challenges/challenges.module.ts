import { Logger, Module } from "@nestjs/common";
import { PostgresModule } from "../postgres/postgres.module";
import { YpointModule } from "../ypoint/ypoint.module";
import { ChallengesController } from "./challenges.controller";
import { ChallengesService } from "./challenges.service";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [PostgresModule, YpointModule],
  controllers: [ChallengesController],
  providers: [ChallengesService, loggerFactory()],
  exports: [ChallengesService],
})
export class ChallengesModule {}
