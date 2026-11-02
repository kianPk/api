import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "fs";
import { join } from "path";
import { AppConfig } from "../configs/types/AppConfig";

export type DomesticKitStatus = {
  ready: boolean;
  path: string;
  preparedAt: string | null;
  k3sVersion: string | null;
  imageTars: number;
  pluginZips: number;
  hasK3sBinary: boolean;
  hasInstallScript: boolean;
};

/**
 * Host-path kit prepared by scripts/prepare-domestic-node-kit-vps.sh.
 * When international registries are unreachable, join scripts and plugin
 * desired URLs are rewritten to files served from this directory.
 */
@Injectable()
export class DomesticKitService {
  private readonly logger = new Logger(DomesticKitService.name);
  private readonly kitPath: string;
  private readonly appConfig: AppConfig;

  constructor(config: ConfigService) {
    this.kitPath = (
      process.env.DOMESTIC_KIT_PATH || "/opt/5stack/domestic-kit"
    ).replace(/\/+$/, "");
    this.appConfig = config.get<AppConfig>("app");
  }

  public get path(): string {
    return this.kitPath;
  }

  public isReady(): boolean {
    return (
      existsSync(join(this.kitPath, "bin", "k3s")) &&
      existsSync(join(this.kitPath, "k3s", "install.sh"))
    );
  }

  public status(): DomesticKitStatus {
    const manifestPath = join(this.kitPath, "manifest.json");
    let preparedAt: string | null = null;
    let k3sVersion: string | null = null;
    if (existsSync(manifestPath)) {
      try {
        const raw = readFileSync(manifestPath, "utf8");
        const parsed = JSON.parse(raw) as {
          prepared_at?: string;
          k3s_version?: string;
        };
        preparedAt = parsed.prepared_at ?? null;
        k3sVersion = parsed.k3s_version ?? null;
      } catch (error) {
        this.logger.warn(`domestic kit manifest unreadable: ${error}`);
      }
    }

    const countFiles = (dir: string, ext: string): number => {
      const full = join(this.kitPath, dir);
      if (!existsSync(full)) {
        return 0;
      }
      return readdirSync(full).filter((name) => name.endsWith(ext)).length;
    };

    return {
      ready: this.isReady(),
      path: this.kitPath,
      preparedAt,
      k3sVersion,
      imageTars: countFiles("images", ".tar"),
      pluginZips: countFiles("plugins", ".zip"),
      hasK3sBinary: existsSync(join(this.kitPath, "bin", "k3s")),
      hasInstallScript: existsSync(join(this.kitPath, "k3s", "install.sh")),
    };
  }

  /** Absolute path inside the kit, or null if missing / path escape. */
  public resolveKitFile(...parts: string[]): string | null {
    const full = join(this.kitPath, ...parts);
    if (!full.startsWith(this.kitPath + "/") && full !== this.kitPath) {
      return null;
    }
    if (!existsSync(full) || !statSync(full).isFile()) {
      return null;
    }
    return full;
  }

  public openKitFile(...parts: string[]) {
    const full = this.resolveKitFile(...parts);
    if (!full) {
      return null;
    }
    return createReadStream(full);
  }

  public listImageArchives(): string[] {
    const dir = join(this.kitPath, "images");
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir).filter(
      (name) => name.endsWith(".tar") || name.endsWith(".tar.gz"),
    );
  }

  public pluginCacheUrl(sha256: string): string | null {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      return null;
    }
    if (!this.resolveKitFile("plugins", `${sha256}.zip`)) {
      return null;
    }
    const base = (this.appConfig?.apiDomain || "").replace(/\/+$/, "");
    if (!base) {
      return null;
    }
    return `${base}/game-server-node/domestic/plugins/${sha256}.zip`;
  }
}
