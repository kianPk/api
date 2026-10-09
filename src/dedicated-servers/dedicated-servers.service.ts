import { Injectable, Logger } from "@nestjs/common";
import { CoreV1Api, AppsV1Api, KubeConfig } from "@kubernetes/client-node";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "src/configs/types/AppConfig";
import { GameServersConfig } from "src/configs/types/GameServersConfig";
import { EncryptionService } from "src/encryption/encryption.service";
import { HasuraService } from "src/hasura/hasura.service";
import { e_server_types_enum } from "../../generated";
import { RconService } from "src/rcon/rcon.service";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { Redis } from "ioredis";
import { SystemService } from "src/system/system.service";
import { PluginRuntimeService } from "src/plugin-runtime/plugin-runtime.service";
import { GameModesService } from "../game-plugins/game-modes.service";
import { PostgresService } from "../postgres/postgres.service";
import {
  SECTION_MAP_ID,
  isServerSectionMode,
} from "../game-plugins/server-section-modes";

@Injectable()
export class DedicatedServersService {
  private appConfig: AppConfig;
  private gameServerConfig: GameServersConfig;
  private readonly namespace: string;

  private core: CoreV1Api;
  private apps: AppsV1Api;

  private redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly encryption: EncryptionService,
    private readonly RconService: RconService,
    private readonly redisManager: RedisManagerService,
    private readonly systemService: SystemService,
    private readonly pluginRuntimeService: PluginRuntimeService,
    private readonly gameModesService: GameModesService,
    private readonly postgres: PostgresService,
  ) {
    this.redis = this.redisManager.getConnection();

    this.appConfig = this.config.get<AppConfig>("app");
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");

    this.namespace = this.gameServerConfig.namespace;

    const kc = new KubeConfig();
    kc.loadFromDefault();

    this.core = kc.makeApiClient(CoreV1Api);
    this.apps = kc.makeApiClient(AppsV1Api);
  }

  public async setupDedicatedServer(serverId: string): Promise<boolean> {
    this.logger.log(`[${serverId}] assigning dedicated server`);

    const { servers_by_pk: server } = await this.hasura.query({
      servers_by_pk: {
        __args: {
          id: serverId,
        },
        id: true,
        host: true,
        type: true,
        port: true,
        tv_port: true,
        game: true,
        max_players: true,
        api_password: true,
        rcon_password: true,
        connect_password: true,
        game_server_node: {
          id: true,
          pin_plugin_version: true,
          pin_plugin_runtime: true,
          supports_cpu_pinning: true,
        },
        server_region: {
          is_lan: true,
          steam_relay: true,
        },
      },
    });

    try {
      this.logger.verbose(
        `[${serverId}] create deployment for dedicated server`,
      );

      const gameServerNodeId = server.game_server_node?.id;
      const steamRelay = server.server_region?.steam_relay || false;

      let cpus: string;
      if (server.game_server_node?.supports_cpu_pinning) {
        const { settings } = await this.hasura.query({
          settings: {
            __args: {
              where: {
                _or: [
                  {
                    name: {
                      _eq: "enable_cpu_pinning",
                    },
                  },
                  {
                    name: {
                      _eq: "number_of_cpus_per_server",
                    },
                  },
                ],
              },
            },
            name: true,
            value: true,
          },
        });

        const cpuPinning = settings.find(
          (setting) => setting.name === "enable_cpu_pinning",
        );

        if (cpuPinning?.value === "true") {
          const numberOfCpus = settings.find(
            (setting) => setting.name === "number_of_cpus_per_server",
          );
          cpus = numberOfCpus?.value || "2";
        }
      }

      const sanitizedGameServerNodeId = gameServerNodeId.replaceAll(".", "-");
      const serverfilesVolumeName =
        server.game === "csgo"
          ? `serverfiles-csgo-${sanitizedGameServerNodeId}`
          : `serverfiles-${sanitizedGameServerNodeId}`;

      const pluginRuntime =
        await this.pluginRuntimeService.resolvePluginRuntime(
          server.game_server_node,
        );

      const pluginImage =
        await this.pluginRuntimeService.resolveGameServerPluginImage(
          server.game_server_node,
          pluginRuntime,
        );

      // Seeded here so out-of-date checks know the framework even before the
      // plugin's first ping; the ping overwrites it with what actually loaded.
      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: {
              id: serverId,
            },
            _set: {
              plugin_runtime: pluginRuntime,
            },
          },
          __typename: true,
        },
      });

      // A Ranked server resolves to no mode by design, so matchmaking capacity
      // always comes up on a clean plugin set.
      const gameMode = this.gameModesService.withPublicServerCfg(
        await this.gameModesService.resolveForServer(serverId),
      );

      const gameModeEnvironment =
        this.gameModesService.environmentFor(gameMode);

      // A mode built around workshop maps names its first one; booting
      // de_dust2 underneath it would load a map only to leave it again.
      const startMap = /(^|\s)\+(map|host_workshop_map)\s/.test(
        gameMode?.extraGameParams || "",
      )
        ? ""
        : "+map de_dust2";

      const dedicatedServerDeploymentName =
        this.getDedicatedServerDeploymentName(serverId);

      const { steamAccountToken, isHosted } =
        await this.getServerHostingInfo(serverId);

      const launchExtras = [
        // Without this the server hibernates before its Steam logon finishes
        // and sits at "Waiting for Steam login" with nobody able to join.
        server.type !== "Ranked" ? "+sv_hibernate_when_empty 0" : "",
        steamAccountToken &&
        !/\bsv_setsteamaccount\b/i.test(gameMode?.extraGameParams || "")
          ? `+sv_setsteamaccount ${steamAccountToken}`
          : "",
      ]
        .filter(Boolean)
        .join(" ");

      await this.apps.createNamespacedDeployment({
        namespace: this.namespace,
        body: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: dedicatedServerDeploymentName,
          },
          spec: {
            replicas: 1,
            strategy: {
              type: "Recreate",
            },
            selector: {
              matchLabels: {
                app: dedicatedServerDeploymentName,
              },
            },
            template: {
              metadata: {
                name: dedicatedServerDeploymentName,
                labels: {
                  app: dedicatedServerDeploymentName,
                },
              },
              spec: {
                dnsConfig: {
                  options: [
                    {
                      name: "ndots",
                      value: "1",
                    },
                  ],
                },
                hostNetwork: true,
                affinity: {
                  nodeAffinity: {
                    requiredDuringSchedulingIgnoredDuringExecution: {
                      nodeSelectorTerms: [
                        {
                          matchExpressions: [
                            {
                              key: "kubernetes.io/hostname",
                              operator: "In",
                              values: [gameServerNodeId],
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
                ...(isHosted
                  ? {
                      initContainers: [
                        {
                          name: "hosted-plugins",
                          image: pluginImage,
                          command: ["sh", "-c", this.hostedPluginInitScript()],
                          volumeMounts: [
                            {
                              name: `dedicated-server-data-${server.id}`,
                              mountPath: "/opt/custom-plugins",
                            },
                            {
                              name: `hosted-template-${sanitizedGameServerNodeId}`,
                              mountPath: "/opt/hosted-template",
                              readOnly: true,
                            },
                          ],
                        },
                      ],
                    }
                  : {}),
                containers: [
                  {
                    name: "game-server",
                    image: pluginImage,
                    ...(cpus
                      ? {
                          resources: {
                            requests: { cpu: cpus },
                            limits: { cpu: cpus },
                          },
                        }
                      : {}),
                    ports: [
                      { containerPort: server.port },
                      { containerPort: server.port, protocol: "UDP" },
                      { containerPort: server.tv_port, protocol: "TCP" },
                      { containerPort: server.tv_port, protocol: "UDP" },
                    ],
                    env: [
                      {
                        name: "GAME_ID",
                        value: server.game === "csgo" ? "740" : "730",
                      },
                      {
                        name: "SERVER_TYPE",
                        value: server.type,
                      },
                      {
                        name: "INSTALL_5STACK_PLUGIN",
                        value: server.type === "Ranked" ? "true" : "false",
                      },
                      // A practice server runs the utility plugin in the match
                      // plugin's place -- never both, and never neither.
                      {
                        name: "INSTALL_UTILITY_PRACTICE_PLUGIN",
                        value: server.type === "Practice" ? "true" : "false",
                      },
                      {
                        name: "GAME_NODE_SERVER",
                        value: "true",
                      },
                      { name: "SERVER_PORT", value: server.port.toString() },
                      { name: "TV_PORT", value: server.tv_port.toString() },
                      {
                        name: "RCON_PASSWORD",
                        value: await this.encryption.decrypt(
                          server.rcon_password,
                        ),
                      },
                      // TODO - number of players
                      {
                        name: "EXTRA_GAME_PARAMS",
                        // Public/custom need a Valve stock mapgroup (e.g. mg_active)
                        // for endmatch VOTING UI with real names/thumbnails.
                        // Custom mg_* in gamemodes_server.txt often shows "undefined".
                        // Ranked picks maps from the match, so leave mapgroup off there.
                        value: `-maxplayers ${server.type === "Ranked" ? 16 : server.max_players} ${startMap}${server.type === "Ranked" ? "" : " +mapgroup mg_active"} +game_type ${this.getGameType(server.type)} +game_mode ${this.getGameMode(server.type)} +sv_skirmish_id ${this.getWarGameType(server.type)} ${server.connect_password ? ` +sv_password ${server.connect_password}` : ""}${launchExtras ? ` ${launchExtras}` : ""}${gameMode?.extraGameParams ? ` ${gameMode.extraGameParams}` : ""}`,
                      },
                      { name: "SERVER_ID", value: server.id },
                      {
                        name: "SERVER_API_PASSWORD",
                        value: server.api_password,
                      },
                      {
                        name: "API_DOMAIN",
                        value: this.appConfig.apiDomain,
                      },
                      {
                        name: "RELAY_DOMAIN",
                        value: this.appConfig.relayDomain,
                      },
                      {
                        name: "DEMOS_DOMAIN",
                        value: this.appConfig.demosDomain,
                      },
                      {
                        name: "WS_DOMAIN",
                        value: this.appConfig.wsDomain,
                      },
                      {
                        name: "STEAM_RELAY",
                        value: steamRelay ? "true" : "false",
                      },
                      ...gameModeEnvironment,
                    ],
                    volumeMounts: [
                      {
                        name: `steamcmd-${sanitizedGameServerNodeId}`,
                        mountPath: "/serverdata/steamcmd",
                      },
                      {
                        name: serverfilesVolumeName,
                        mountPath: "/serverdata/serverfiles",
                      },
                      {
                        name: `demos-${sanitizedGameServerNodeId}`,
                        mountPath: "/opt/demos",
                      },
                      {
                        name: `dedicated-server-data-${server.id}`,
                        mountPath: `/opt/custom-plugins`,
                      },
                      // A dedicated server only ever saw its own directory, so
                      // a plugin installed on the node reached every on-demand
                      // match server and none of these. Mounted read-write
                      // because a plugin writes its config on first load and
                      // that has to survive the pod.
                      {
                        name: `custom-plugins-${sanitizedGameServerNodeId}`,
                        mountPath: `/opt/node-plugins`,
                      },
                    ],
                  },
                ],
                volumes: [
                  {
                    name: `steamcmd-${sanitizedGameServerNodeId}`,
                    persistentVolumeClaim: {
                      claimName: `steamcmd-${sanitizedGameServerNodeId}-claim`,
                    },
                  },
                  {
                    name: serverfilesVolumeName,
                    persistentVolumeClaim: {
                      claimName: `${serverfilesVolumeName}-claim`,
                    },
                  },
                  {
                    name: `demos-${sanitizedGameServerNodeId}`,
                    persistentVolumeClaim: {
                      claimName: `demos-${sanitizedGameServerNodeId}-claim`,
                    },
                  },
                  {
                    name: `dedicated-server-data-${server.id}`,
                    hostPath: {
                      type: "DirectoryOrCreate",
                      path: `/opt/5stack/servers/${server.id}`,
                    },
                  },
                  {
                    name: `custom-plugins-${sanitizedGameServerNodeId}`,
                    hostPath: {
                      type: "DirectoryOrCreate",
                      path: `/opt/5stack/custom-plugins`,
                    },
                  },
                  ...(isHosted
                    ? [
                        {
                          name: `hosted-template-${sanitizedGameServerNodeId}`,
                          hostPath: {
                            type: "DirectoryOrCreate",
                            path: `/opt/5stack/hosted-template`,
                          },
                        },
                      ]
                    : []),
                ],
              },
            },
          },
        },
      });

      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: { id: serverId },
            _set: {
              connected: false,
              steam_relay: null,
            },
          },
          id: true,
        },
      });

      void this.waitForPodReady(serverId)
        .then(() => {
          setTimeout(async () => {
            this.logger.verbose(`[${serverId}] dedicated server is ready`);
            await this.pingDedicatedServer(serverId);
          }, 10000);
        })
        .catch((error) => {
          this.logger.error(
            `[${serverId}] error waiting for pod to be ready`,
            error,
          );
        });

      return true;
    } catch (error) {
      await this.removeDedicatedServer(serverId);

      this.logger.error(
        `[${serverId}] unable to create dedicated server`,
        error?.response?.body?.message || error,
      );

      return false;
    }
  }

  public async removeDedicatedServer(serverId: string): Promise<void> {
    this.logger.log(`[${serverId}] removing dedicated server`);

    const dedicatedServerDeploymentName = `dedicated-server-${serverId}`;

    try {
      await this.apps.deleteNamespacedDeployment({
        namespace: this.namespace,
        name: dedicatedServerDeploymentName,
      });
    } catch (error) {
      if (error.code.toString() !== "404") {
        throw error;
      }
    } finally {
      await this.redis.hdel("dedicated-servers:stats", serverId);

      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: { id: serverId },
            _set: {
              connected: false,
              steam_relay: null,
            },
          },
          id: true,
        },
      });
    }
  }

  private getGameType(type: e_server_types_enum): number {
    switch (type) {
      case "Ranked":
      case "Casual":
      case "Competitive":
      case "Wingman":
      // Public/Custom dedicated boxes need Classic (0) so Valve endmatch
      // map vote (VOTING / thumbnails) works. game_type 3 = Custom mode
      // skips that UI entirely.
      case "Custom":
        return 0;
      case "Deathmatch":
      case "ArmsRace":
        return 1;
      case "Retake":
        return 3;
    }
  }

  private getWarGameType(type: e_server_types_enum): number {
    switch (type) {
      case "Retake":
        return 12;
      default:
        return 0;
    }
  }

  private getGameMode(type: e_server_types_enum): number {
    switch (type) {
      case "Ranked":
      case "Competitive":
        return 1;
      case "ArmsRace":
      case "Casual":
        return 0;
      case "Wingman":
      case "Deathmatch":
        return 2;
      case "Retake":
      case "Custom":
        return 0;
    }
  }

  private async getServerStatusInfo(
    serverId: string,
    game: string,
    steamRelayEnabled: boolean,
  ): Promise<{
    steamId: string | null;
    clients_human: number;
    map: string;
    players: Array<{ steam_id: string; name: string }>;
  }> {
    const rcon = await this.RconService.connect(serverId);
    if (!rcon) {
      return;
    }

    if (game === "csgo") {
      const output = await rcon.send("status");
      const mapMatch = output.match(/^map\s*:\s*(\S+)/m);
      const playersMatch = output.match(/^players\s*:\s*(\d+)\s+humans/m);
      return {
        steamId: null,
        clients_human: playersMatch ? parseInt(playersMatch[1]) : 0,
        map: mapMatch ? mapMatch[1] : "unknown",
        players: this.parseStatusText(output).map(({ steam_id, name }) => ({
          steam_id,
          name,
        })),
      };
    } else {
      const raw = await rcon.send("status_json");
      const status = JSON.parse(raw);
      return {
        steamId: steamRelayEnabled ? status.server.steamid : null,
        clients_human: status.server.clients_human,
        map: status.server.map || "unknown",
        players: this.parseStatusJson(raw).map(({ steam_id, name }) => ({
          steam_id,
          name,
        })),
      };
    }
  }

  // The mode's plugin makes the change, so it knows the map it is on and its
  // vote and rotation carry on from there.
  public async changeSectionServerMap(serverId: string, mapId: string) {
    if (!SECTION_MAP_ID.test(mapId)) {
      throw Error("not a workshop id or a map name");
    }

    const [server] = await this.postgres.query<
      Array<{ section_mode: string | null }>
    >(`SELECT section_mode FROM servers WHERE id = $1`, [serverId]);

    if (!isServerSectionMode(server?.section_mode)) {
      throw Error("only a Servers section server changes its map from here");
    }

    const rcon = await this.RconService.connect(serverId);
    if (!rcon) {
      throw Error(`unable to connect to rcon for server ${serverId}`);
    }

    try {
      await rcon.send(`css_servers_map ${mapId}`);
    } finally {
      await this.RconService.disconnect(serverId);
    }
  }

  public async getServerPlayerList(
    serverId: string,
  ): Promise<Array<{ steam_id: string; name: string; userid: string | null }>> {
    const { servers_by_pk: server } = await this.hasura.query({
      servers_by_pk: {
        __args: { id: serverId },
        game: true,
      },
    });

    if (!server) {
      throw Error(`unable to find server ${serverId}`);
    }

    const rcon = await this.RconService.connect(serverId);
    if (!rcon) {
      throw Error(`unable to connect to rcon for server ${serverId}`);
    }

    try {
      if (server.game === "csgo") {
        return this.parseStatusText(await rcon.send("status"));
      }

      return this.parseStatusJson(await rcon.send("status_json"));
    } finally {
      await this.RconService.disconnect(serverId);
    }
  }

  public async resolveServerUserId(
    serverId: string,
    steamId: string,
  ): Promise<string | null> {
    const rcon = await this.RconService.connect(serverId);
    if (!rcon) {
      return null;
    }

    try {
      const output = await rcon.send("status");
      const userid = this.parseUserIdFromStatus(output, steamId);

      if (!userid) {
        this.logger.warn(
          `could not resolve userid for ${steamId} on ${serverId}; status output:\n${output}`,
        );
      }

      return userid;
    } finally {
      await this.RconService.disconnect(serverId);
    }
  }

  /** Resolve userid + kick in one RCON session (avoids race between status and kick). */
  public async kickSteamId(
    serverId: string,
    steamId: string,
    reason: string,
  ): Promise<boolean> {
    const rcon = await this.RconService.connect(serverId);
    if (!rcon) {
      return false;
    }

    try {
      const output = await rcon.send("status");
      const userid = this.parseUserIdFromStatus(output, steamId);
      if (!userid) {
        this.logger.warn(
          `kickSteamId: could not resolve userid for ${steamId} on ${serverId}`,
        );
        return false;
      }
      const safe = reason
        .replace(/[\r\n";]/g, " ")
        .trim()
        .slice(0, 120);
      await rcon.send(`kickid ${userid} ${safe}`);
      return true;
    } finally {
      await this.RconService.disconnect(serverId);
    }
  }

  private parseUserIdFromStatus(
    output: string,
    steamId: string,
  ): string | null {
    let steamId3: string | null = null;
    let steamLegacy: RegExp | null = null;

    try {
      const accountId = BigInt(steamId) - 76561197960265728n;
      steamId3 = `[U:1:${accountId}]`;
      const authServer = accountId % 2n;
      const accountNumber = accountId / 2n;
      steamLegacy = new RegExp(`STEAM_[0-9]:${authServer}:${accountNumber}\\b`);
    } catch {
      steamId3 = null;
    }

    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();

      const matches =
        (steamId3 && line.includes(steamId3)) ||
        line.includes(steamId) ||
        (steamLegacy !== null && steamLegacy.test(line));

      if (!matches) {
        continue;
      }

      const beforeName = line.match(/(\d+)\s+"/);
      if (beforeName) {
        return beforeName[1];
      }

      const anyNumber = line.match(/\d+/);
      if (anyNumber) {
        return anyNumber[0];
      }
    }

    return null;
  }

  private parseStatusJson(
    raw: string,
  ): Array<{ steam_id: string; name: string; userid: string | null }> {
    let status: Record<string, unknown>;
    try {
      status = JSON.parse(raw);
    } catch {
      return [];
    }

    const clients = (status.clients ||
      status.players ||
      (status.server as Record<string, unknown>)?.clients ||
      []) as Array<Record<string, unknown>>;

    if (!Array.isArray(clients)) {
      return [];
    }

    const players: Array<{
      steam_id: string;
      name: string;
      userid: string | null;
    }> = [];

    for (const client of clients) {
      const steamId =
        client.steamid64 ||
        client.steamid ||
        client.steamId ||
        client.xuid ||
        client.accountid;

      if (
        !steamId ||
        client.fake_player ||
        client.is_bot ||
        client.bot ||
        !this.isRealSteamId(`${steamId}`)
      ) {
        continue;
      }

      const userid =
        client.userid ??
        client.userId ??
        client.user_id ??
        client.id ??
        client.slot;

      players.push({
        steam_id: `${steamId}`,
        name: `${client.name ?? ""}`,
        userid: userid != null ? `${userid}` : null,
      });
    }

    return players;
  }

  private isRealSteamId(steamId: string): boolean {
    if (!/^\d+$/.test(steamId)) {
      return false;
    }

    try {
      const id = BigInt(steamId);
      return id >= 76561197960265728n && id <= 76561202255233023n;
    } catch {
      return false;
    }
  }

  private parseStatusText(
    raw: string,
  ): Array<{ steam_id: string; name: string; userid: string | null }> {
    const players: Array<{
      steam_id: string;
      name: string;
      userid: string | null;
    }> = [];

    for (const line of raw.split(/\r?\n/)) {
      const steamMatch = line.match(/STEAM_(\d):(\d):(\d+)/);
      if (!steamMatch) {
        continue;
      }

      const useridMatch = line.match(/^#\s*(\d+)/);
      const nameMatch = line.match(/"([^"]*)"/);

      const universe = BigInt(steamMatch[1]);
      const authServer = BigInt(steamMatch[2]);
      const accountNumber = BigInt(steamMatch[3]);
      const steamId64 =
        76561197960265728n +
        (universe > 0n ? (universe - 1n) << 56n : 0n) +
        accountNumber * 2n +
        authServer;

      players.push({
        steam_id: steamId64.toString(),
        name: nameMatch ? nameMatch[1] : "",
        userid: useridMatch ? useridMatch[1] : null,
      });
    }

    return players;
  }

  public async pingDedicatedServer(serverId: string): Promise<void> {
    const { servers_by_pk: server } = await this.hasura.query({
      servers_by_pk: {
        __args: { id: serverId },
        game: true,
        enabled: true,
        connected: true,
        steam_relay: true,
        game_server_node_id: true,
        server_region: {
          steam_relay: true,
        },
      },
    });

    // A disabled node-managed server has its deployment torn down and may still
    // be shutting down; never bring it back online. External servers keep
    // running independently, so a disabled one can still be online.
    if (!server.enabled && server.game_server_node_id) {
      if (server.connected) {
        await this.hasura.mutation({
          update_servers_by_pk: {
            __args: {
              pk_columns: { id: serverId },
              _set: {
                connected: false,
                offline_at: new Date().toISOString(),
              },
            },
            id: true,
          },
        });
      }
      return;
    }

    if (!server.connected) {
      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: { pk_columns: { id: serverId }, _set: { connected: true } },
          id: true,
        },
      });
    }

    // TODO - fix steam relay for csgo
    const steamRelayeEnabled =
      server.game === "csgo" ? false : server.server_region?.steam_relay;
    const statusInfo = await this.getServerStatusInfo(
      serverId,
      server.game,
      steamRelayeEnabled,
    );

    if (!statusInfo) {
      return;
    }

    const { steamId, clients_human, map, players } = statusInfo;

    await this.redis.hset(
      "dedicated-servers:stats",
      serverId,
      JSON.stringify({
        clients_human,
        map,
        players: players.slice(0, 64),
        last_ping: new Date().toISOString(),
      }),
    );

    await this.redis.expire("dedicated-servers:stats", 120);

    if (server.steam_relay !== steamId) {
      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: { id: serverId },
            _set: {
              steam_relay: steamId,
              connected: !steamRelayeEnabled || steamId !== null,
            },
          },
          id: true,
        },
      });
    }

    await this.RconService.disconnect(serverId);
  }

  public async restartDedicatedServer(serverId: string): Promise<void> {
    // Recreate rather than flip the existing Deployment: ENABLED_PLUGINS is
    // baked into the pod env at setup time. A plain rollout restart kept the
    // old list, so newly installed auto-load plugins (e.g. AntiNoclip) never
    // linked into Public servers until the Deployment was rebuilt.
    await this.removeDedicatedServer(serverId);
    const ok = await this.setupDedicatedServer(serverId);
    if (!ok) {
      throw new Error(
        `failed to recreate dedicated server ${serverId} after restart`,
      );
    }
  }

  public async getAllDedicatedServerStats(): Promise<
    Array<{
      id: string;
      players: number;
      map?: string;
      last_ping?: string;
    }>
  > {
    try {
      const allServerData = await this.redis.hgetall("dedicated-servers:stats");

      if (!allServerData || Object.keys(allServerData).length === 0) {
        return [];
      }

      return Object.entries(allServerData)
        .map(([serverId, jsonData]) => {
          try {
            const data = JSON.parse(jsonData);

            return {
              id: serverId,
              map: data.map,
              lastPing: data.last_ping,
              players: parseInt(data.clients_human),
            };
          } catch (error) {
            this.logger.warn(
              `Failed to parse server data for ${serverId}:`,
              error,
            );
          }
        })
        .filter((result) => {
          return !!result;
        });
    } catch (error) {
      this.logger.error(
        "Failed to get dedicated server stats from Redis",
        error,
      );
      return [];
    }
  }

  public async getCachedServerPlayers(serverId: string): Promise<{
    map: string | null;
    last_ping: string | null;
    players: Array<{ steam_id: string; name: string }>;
  }> {
    const raw = await this.redis.hget("dedicated-servers:stats", serverId);
    if (!raw) {
      return { map: null, last_ping: null, players: [] };
    }
    try {
      const data = JSON.parse(raw);
      return {
        map: data.map ?? null,
        last_ping: data.last_ping ?? null,
        players: Array.isArray(data.players) ? data.players : [],
      };
    } catch {
      return { map: null, last_ping: null, players: [] };
    }
  }

  private getDedicatedServerDeploymentName(serverId: string): string {
    return `dedicated-server-${serverId}`;
  }

  private async getServerHostingInfo(
    serverId: string,
  ): Promise<{ steamAccountToken: string | null; isHosted: boolean }> {
    try {
      const [row] = await this.postgres.query<
        Array<{ steam_account_token: string | null; is_hosted: boolean }>
      >(
        `SELECT s.steam_account_token,
                EXISTS (
                  SELECT 1 FROM hosted_servers h
                  WHERE h.server_id = s.id OR h.pending_server_id = s.id
                ) AS is_hosted
         FROM servers s WHERE s.id = $1`,
        [serverId],
      );
      const token = row?.steam_account_token?.trim() || null;
      return {
        steamAccountToken:
          token && /^[A-F0-9]{32}$/i.test(token) ? token : null,
        isHosted: Boolean(row?.is_hosted),
      };
    } catch (error) {
      this.logger.warn(
        `[${serverId}] hosting info unavailable: ${error?.message || error}`,
      );
      return { steamAccountToken: null, isHosted: false };
    }
  }

  // Seeds a rented server's own plugin directory from the node's template once,
  // and always shadows FiveStack: the node directory carries the ranked match
  // plugin, which must never load on a non-match server.
  private hostedPluginInitScript(): string {
    return [
      "set -e",
      "dest=/opt/custom-plugins",
      'if [ ! -f "$dest/.hosted-template-applied" ]; then',
      '  cp -a /opt/hosted-template/. "$dest"/ 2>/dev/null || true',
      '  touch "$dest/.hosted-template-applied"',
      "fi",
      'mkdir -p "$dest/addons/counterstrikesharp/plugins/FiveStack"',
      'find "$dest/addons/counterstrikesharp/plugins/FiveStack" -mindepth 1 -delete 2>/dev/null || true',
    ].join("\n");
  }

  private async waitForPodReady(
    serverId: string,
    maxWaitTime: number = 60 * 1000,
  ): Promise<void> {
    const deploymentName = this.getDedicatedServerDeploymentName(serverId);
    const startTime = Date.now();

    this.logger.log(`[${serverId}] waiting for pod to be ready`);

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;

      const checkPodStatus = async () => {
        try {
          const deployment = await this.apps.readNamespacedDeployment({
            name: deploymentName,
            namespace: this.namespace,
          });

          const readyReplicas = deployment.status?.readyReplicas || 0;
          const desiredReplicas = deployment.spec?.replicas || 1;

          if (readyReplicas >= desiredReplicas) {
            resolve();
            return;
          }
        } catch (error) {
          this.logger.warn(
            `[${serverId}] error checking pod status: ${error.message}`,
          );
        }

        if (Date.now() - startTime >= maxWaitTime) {
          reject(
            new Error(
              `[${serverId}] timeout waiting for pod to be ready after ${maxWaitTime}ms`,
            ),
          );
          return;
        }

        timer = setTimeout(checkPodStatus, 5000);
      };

      void checkPodStatus();
    });
  }
}
