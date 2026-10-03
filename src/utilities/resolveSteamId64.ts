import { BadRequestException } from "@nestjs/common";

const STEAM_ID64 = /\b(7656119\d{10})\b/;
const VANITY_URL = /steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,32})/i;
const BARE_VANITY = /^[A-Za-z0-9_-]{2,32}$/;

/**
 * Accepts a SteamID64, a /profiles/ link, a custom /id/ link or a bare custom
 * id, and returns the SteamID64. Custom ids are resolved through the Web API
 * when a key is set, otherwise through the public profile XML.
 */
export async function resolveSteamId64(
  input: unknown,
  steamApiKey?: string | null,
): Promise<string> {
  const raw = String(input ?? "").trim();
  const direct = raw.match(STEAM_ID64);
  if (direct) {
    return direct[1];
  }

  const vanity =
    raw.match(VANITY_URL)?.[1] ?? (BARE_VANITY.test(raw) ? raw : null);
  if (!vanity) {
    throw new BadRequestException(
      "Enter a SteamID64 or a steamcommunity.com profile link",
    );
  }

  const resolved =
    (steamApiKey && (await viaWebApi(vanity, steamApiKey))) ||
    (await viaProfileXml(vanity));
  if (!resolved) {
    throw new BadRequestException(
      `Could not find a Steam profile for "${vanity}". Use the SteamID64 instead.`,
    );
  }
  return resolved;
}

async function viaWebApi(vanity: string, key: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(key)}&vanityurl=${encodeURIComponent(vanity)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      response?: { success?: number; steamid?: string };
    };
    const id = body.response?.success === 1 ? body.response.steamid : null;
    return id && STEAM_ID64.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function viaProfileXml(vanity: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) return null;
    const xml = await response.text();
    return xml.match(/<steamID64>(7656119\d{10})<\/steamID64>/)?.[1] ?? null;
  } catch {
    return null;
  }
}
