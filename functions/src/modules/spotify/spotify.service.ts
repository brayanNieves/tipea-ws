import { spotifyClientId, spotifyClientSecret } from "../../config/spotify";
import {
  fetchSpotifyClientCredentialsToken,
  searchSpotifyTracks as searchSpotifyTracksClient,
} from "../../shared/http/spotify.client";
import { spotifyTokenRepo } from "./spotify-token.repository";
import type {
  SpotifySearchTracksResponse,
  SpotifyTokenSource,
} from "./spotify.types";

// Renovar un poco antes de la expiración real para evitar race conditions
// entre request inflight y cambio de token.
const REFRESH_BUFFER_MS = 60 * 1000; // 60s

export interface AccessTokenResult {
  accessToken: string;
  expiresAt: number; // epoch ms
  source: SpotifyTokenSource;
}

/**
 * Returns a valid Spotify access token.
 * Uses Firestore-cached token while fresh; otherwise fetches from Spotify
 * and persists the new token + expiry.
 *
 * @param forceRefresh  skip the cache and always fetch a new token
 */
export async function getSpotifyAccessToken(
  forceRefresh = false
): Promise<AccessTokenResult> {
  // 1) Try cache (unless forced to refresh)
  if (!forceRefresh) {
    try {
      const cached = await spotifyTokenRepo.read();
      if (cached && cached.expiresAt - REFRESH_BUFFER_MS > Date.now()) {
        return {
          accessToken: cached.accessToken,
          expiresAt: cached.expiresAt,
          source: "cache",
        };
      }
    } catch (e) {
      console.warn("[spotify.service] cache read failed, will fetch", e);
    }
  }

  // 2) Fetch from Spotify
  const clientId = spotifyClientId.value();
  const clientSecret = spotifyClientSecret.value();
  if (!clientId || !clientSecret) {
    throw new Error("Spotify credentials not configured (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET)");
  }

  const { access_token, expires_in } = await fetchSpotifyClientCredentialsToken(
    clientId,
    clientSecret
  );

  // 3) Persist cache (best-effort; don't fail the request if this fails)
  await spotifyTokenRepo.write(access_token, expires_in).catch((e) => {
    console.warn("[spotify.service] cache write failed", e);
  });

  return {
    accessToken: access_token,
    expiresAt: Date.now() + expires_in * 1000,
    source: "api",
  };
}

/**
 * Searches Spotify tracks using the service's cached client-credentials token.
 * Retries ONCE with a freshly-fetched token if Spotify returns 401
 * (token was invalidated earlier than expected).
 */
export async function searchTracks(
  query: string,
  limit = 50,
  offset = 0,
  market?: string
): Promise<SpotifySearchTracksResponse> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("query is required");

  const { accessToken } = await getSpotifyAccessToken();

  try {
    return await searchSpotifyTracksClient(accessToken, trimmed, limit, offset, market);
  } catch (err) {
    // If Spotify rejected our token mid-life (rare), invalidate cache and retry.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes(" 401")) throw err;

    console.warn("[spotify.service] 401 on search; refreshing token and retrying");
    const { accessToken: fresh } = await getSpotifyAccessToken(true);
    return searchSpotifyTracksClient(fresh, trimmed, limit, offset, market);
  }
}
