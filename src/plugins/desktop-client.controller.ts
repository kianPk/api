import { Controller, Get } from "@nestjs/common";

/**
 * Public desktop (YGuardClient) auto-update metadata.
 * Kept under /plugins so Arvan / ingress already route the prefix.
 */
@Controller("plugins/client")
export class DesktopClientController {
  @Get("launcher")
  public launcher() {
    const version = process.env.DESKTOP_CLIENT_VERSION || "0.2.7";
    const defaultUrl =
      "https://github.com/kianPk/web/releases/download/yguard-client-v0.2.7/YGuardClient-0.2.7-win-x64.zip";
    let downloadUrl =
      process.env.DESKTOP_CLIENT_DOWNLOAD_URL?.trim() || defaultUrl;
    if (
      /yguard-client-v0\.2\.[0-6]\b/i.test(downloadUrl) ||
      /YGuardClient-0\.2\.[0-6]\b/i.test(downloadUrl)
    ) {
      downloadUrl = defaultUrl;
    }
    return {
      version,
      download_url: downloadUrl,
      mandatory: true,
      min_version: process.env.DESKTOP_CLIENT_MIN_VERSION?.trim() || "0.2.7",
    };
  }
}
