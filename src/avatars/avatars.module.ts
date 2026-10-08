import { Module } from "@nestjs/common";
import { AvatarsService } from "./avatars.service";
import { AvatarsController } from "./avatars.controller";
import { S3Module } from "../s3/s3.module";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [S3Module, HasuraModule, PostgresModule],
  providers: [AvatarsService, loggerFactory()],
  controllers: [AvatarsController],
})
export class AvatarsModule {}
