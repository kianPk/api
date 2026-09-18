import { Module } from "@nestjs/common";
import { AnticheatService } from "./anticheat.service";
import { AnticheatController } from "./anticheat.controller";
import { PostgresModule } from "../postgres/postgres.module";
import { SanctionsModule } from "../sanctions/sanctions.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [PostgresModule, SanctionsModule],
  controllers: [AnticheatController],
  providers: [AnticheatService, loggerFactory()],
  exports: [AnticheatService],
})
export class AnticheatModule {}
