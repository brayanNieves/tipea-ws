import { onRequest } from "firebase-functions/v2/https";
import { searchTracksApiKey } from "../../config/api-keys";
import { spotifyClientId, spotifyClientSecret } from "../../config/spotify";
import { requireApiKey } from "../../shared/auth/api-key";
import { corsHandler } from "../../shared/utils/cors";
import { searchTracks as searchTracksService } from "./spotify.service";

// Nota: el Bearer token de Spotify se maneja internamente en el backend
// vía `getSpotifyAccessToken()` en `spotify.service.ts`. No se expone al
// cliente para evitar abuso de rate limit y mantener la credencial en el servidor.

// ─────────────────────────────────────────────────────────────
// searchTracks (HTTP endpoint, API-key protected)
//
// Searches Spotify's catalog for tracks matching a query. The
// backend holds the Bearer token — clients never see it.
//
// Auth:
//   Required header `x-api-key: <SEARCH_TRACKS_API_KEY>`
//
// Accepts:
//   GET  /searchTracks?q=<query>&limit=<1..50>&offset=<n>&market=DO
//   POST /searchTracks   body: { q, limit?, offset?, market? }
//
// Responds 200 with Spotify's raw tracks search payload:
//   { tracks: { items: [SpotifyTrack...], total, limit, offset, ... } }
//
// Errors:
//   400 missing/empty q
//   401 missing x-api-key header
//   403 invalid API key
//   405 method not allowed
//   502 upstream Spotify failure
// ─────────────────────────────────────────────────────────────
export const searchTracks = onRequest(
  { secrets: [spotifyClientId, spotifyClientSecret, searchTracksApiKey] },
  (req, res) => {
    corsHandler(req, res, async () => {
      if (req.method !== "GET" && req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
      }

      if (!requireApiKey(req, res, searchTracksApiKey.value())) return;

      const source = req.method === "GET" ? req.query : req.body ?? {};
      const q = typeof source.q === "string" ? source.q.trim() : "";
      if (!q) {
        res.status(400).json({ error: "Missing required param: q" });
        return;
      }

      // limit: default 50, clamp to [1, 50]
      const rawLimit =
        typeof source.limit === "string"
          ? parseInt(source.limit, 10)
          : typeof source.limit === "number"
            ? source.limit
            : NaN;
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 50;

      // offset: default 0, clamp to >= 0
      const rawOffset =
        typeof source.offset === "string"
          ? parseInt(source.offset, 10)
          : typeof source.offset === "number"
            ? source.offset
            : 0;
      const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

      const market = typeof source.market === "string" ? source.market : undefined;

      try {
        const result = await searchTracksService(q, limit, offset, market);

        console.log(
          `✅ [searchTracks] q="${q}" | limit=${limit} | offset=${offset} | ` +
            `total=${result.tracks.total} | returned=${result.tracks.items.length}`
        );

        res.status(200).json(result);
      } catch (error) {
        console.error("❌ [searchTracks]", error);
        res.status(502).json({ error: "Failed to search Spotify tracks" });
      }
    });
  }
);
