import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HostedServerQueues } from "../enums/HostedServerQueues";
import { HostedServersService } from "../hosted-servers.service";

@UseQueue("HostedServers", HostedServerQueues.Lifecycle)
export class ProcessHostedServers extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hostedServers: HostedServersService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.hostedServers.processLifecycle();
    } catch (error) {
      this.logger.error(
        `ProcessHostedServers failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
