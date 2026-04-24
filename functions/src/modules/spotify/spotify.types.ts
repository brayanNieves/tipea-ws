export interface SpotifyTokenResponse {
  access_token: string;
  token_type: "Bearer" | string;
  expires_in: number; // seconds
}

export interface CachedSpotifyToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

export type SpotifyTokenSource = "cache" | "api";

// ─────────────────────────────────────────────────────────────
// Search (subset of Spotify's search response — only fields the
// frontend likely needs; extend as necessary).
// Docs: https://developer.spotify.com/documentation/web-api/reference/search
// ─────────────────────────────────────────────────────────────
export interface SpotifyImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  uri: string;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  images: SpotifyImage[];
  uri: string;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  explicit: boolean;
  preview_url: string | null;
  uri: string;
  external_urls: { spotify: string };
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
}

export interface SpotifySearchTracksResponse {
  tracks: {
    href: string;
    items: SpotifyTrack[];
    limit: number;
    offset: number;
    total: number;
    next: string | null;
    previous: string | null;
  };
}
