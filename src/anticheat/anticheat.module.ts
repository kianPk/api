import { Module } from "@nestjs/common";
import { AnticheatService } from "./anticheat.service";
import { AnticheatController } from "./anticheat.controller";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [PostgresModule],
  controllers: [AnticheatController],
  providers: [AnticheatService, loggerFactory()],
  exports: [AnticheatService],
})
export class AnticheatModule {}
