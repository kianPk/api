import { Controller, Get, Logger } from "@nestjs/common";
import { EventPattern } from "@nestjs/microservices";
import { SocketsService } from "./sockets.service";

@Controller("sockets")
export class SocketsController {
  constructor(
    private readonly logger: Logger,
    private readonly sockets: SocketsService,
  ) {}

  // Public landing counter — no auth. Same Redis presence keys the hub uses.
  @Get("players-online")
  public async playersOnline() {
    return { count: await this.sockets.getOnlinePlayerCount() };
  }

  @EventPattern("answer")
  public async handleAnswer(data: any) {
    await this.handleCandidate(data);
  }

  @EventPattern("candidate")
  public async handleCandidate(data: any) {
    const { peerId, clientId, signal } = data;

    if (!peerId || !clientId) {
      this.logger.error("No peerId or clientId found");
      return;
    }

    await this.sockets.sendMessageToClient(clientId, "candidate", {
      peerId,
      signal,
    });
  }
}
