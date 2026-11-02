import { Module } from "@nestjs/common";
import { DomesticKitService } from "./domestic-kit.service";

@Module({
  providers: [DomesticKitService],
  exports: [DomesticKitService],
})
export class DomesticKitModule {}
