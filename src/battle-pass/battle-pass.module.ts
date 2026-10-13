import { Module } from "@nestjs/common";
import { PostgresModule } from "../postgres/postgres.module";
import { YpointModule } from "../ypoint/ypoint.module";
import { ChallengesModule } from "../challenges/challenges.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { BattlePassController } from "./battle-pass.controller";
import { BattlePassService } from "./battle-pass.service";

@Module({
  imports: [PostgresModule, YpointModule, ChallengesModule],
  controllers: [BattlePassController],
  providers: [BattlePassService, loggerFactory()],
})
export class BattlePassModule {}
