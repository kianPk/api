import { Module } from "@nestjs/common";
import { StoreController } from "./store.controller";
import { StoreService } from "./store.service";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { YpointModule } from "../ypoint/ypoint.module";

@Module({
  imports: [PostgresModule, YpointModule],
  controllers: [StoreController],
  providers: [StoreService, loggerFactory()],
  exports: [StoreService],
})
export class StoreModule {}
