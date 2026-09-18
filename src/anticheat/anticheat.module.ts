import { Module } from "@nestjs/common";
import { AnticheatService } from "./anticheat.service";
import { AnticheatController } from "./anticheat.controller";
import { PostgresModule } from "../postgres/postgres.module";
import { RconModule } from "../rcon/rcon.module";
import { DedicatedServersModule } from "../dedicated-servers/dedicated-servers.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [PostgresModule, RconModule, DedicatedServersModule],
  controllers: [AnticheatController],
  providers: [AnticheatService, loggerFactory()],
  exports: [AnticheatService],
})
export class AnticheatModule {}
