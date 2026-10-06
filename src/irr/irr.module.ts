import { Logger, Module } from "@nestjs/common";
import { IrrService } from "./irr.service";
import { IrrController } from "./irr.controller";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [PostgresModule],
  controllers: [IrrController],
  providers: [IrrService, loggerFactory()],
  exports: [IrrService],
})
export class IrrModule {}
