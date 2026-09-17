import { Logger, Module } from "@nestjs/common";
import { StoreController } from "./store.controller";
import { StoreService } from "./store.service";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [PostgresModule],
  controllers: [StoreController],
  providers: [StoreService, loggerFactory()],
  exports: [StoreService],
})
export class StoreModule {}
