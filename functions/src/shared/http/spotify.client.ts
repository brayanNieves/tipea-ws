import type {
  SpotifySearchTracksResponse,
  SpotifyTokenResponse,
} from "../../modules/spotify/spotify.types";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Requests an access token from Spotify using the Client Credentials flow.
 * Throws on non-2xx, timeout, or malformed response.
 */
export async function fetchSpotifyClientCredentialsToken(
  clientId: string,
  clientSecret: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Don't leak credentials into logs — only status + truncated body.
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Spotify token http ${res.status}: ${snippet}`);
    }

    const json = (await res.json()) as SpotifyTokenResponse;
    if (typeof json.access_token !== "string" || !json.access_token) {
      throw new Error("Spotify token response missing access_token");
    }
    if (typeof json.expires_in !== "number" || json.expires_in <= 0) {
      throw new Error("Spotify token response missing/invalid expires_in");
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Searches Spotify's catalog using the Web API search endpoint.
 * Requires a valid Bearer access token.
 *
 * @param accessToken  Bearer token (client-credentials or user token)
 * @param query        search query (the user's words)
 * @param limit        number of results (1..50). Spotify caps at 50.
 * @param offset       pagination offset (default 0)
 * @param market       optional ISO country code filter (e.g. "DO")
 */
export async function searchSpotifyTracks(
  accessToken: string,
  query: string,
  limit = 50,
  offset = 0,
  market?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<SpotifySearchTracksResponse> {
  const params = new URLSearchParams({
    q: query,
    type: "track",
    limit: String(Math.min(Math.max(limit, 1), 50)),
    offset: String(Math.max(offset, 0)),
  });
  if (market) params.set("market", market);

  const url = `${SPOTIFY_SEARCH_URL}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });

    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Spotify search http ${res.status}: ${snippet}`);
    }

    const json = (await res.json()) as SpotifySearchTracksResponse;
    if (!json?.tracks || !Array.isArray(json.tracks.items)) {
      throw new Error("Spotify search response malformed");
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}
