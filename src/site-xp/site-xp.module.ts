import { Module } from "@nestjs/common";
import { PostgresModule } from "../postgres/postgres.module";
import { SiteXpService } from "./site-xp.service";

@Module({
  imports: [PostgresModule],
  providers: [SiteXpService],
  exports: [SiteXpService],
})
export class SiteXpModule {}
