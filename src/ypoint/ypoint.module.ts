import { Logger, Module } from "@nestjs/common";
import { YpointService } from "./ypoint.service";
import { YpointController } from "./ypoint.controller";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [PostgresModule],
  controllers: [YpointController],
  providers: [YpointService, loggerFactory()],
  exports: [YpointService],
})
export class YpointModule {}
