import { Module } from "@nestjs/common";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { GamenetController } from "./gamenet.controller";
import { GamenetService } from "./gamenet.service";

@Module({
  imports: [PostgresModule],
  controllers: [GamenetController],
  providers: [GamenetService, loggerFactory()],
  exports: [GamenetService],
})
export class GamenetModule {}
