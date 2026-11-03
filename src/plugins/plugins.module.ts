import { Module } from "@nestjs/common";
import { PluginsController } from "./plugins.controller";
import { DesktopClientController } from "./desktop-client.controller";

@Module({
  controllers: [PluginsController, DesktopClientController],
})
export class PluginsModule {}
