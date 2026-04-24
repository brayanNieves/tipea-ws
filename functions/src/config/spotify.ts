import { defineSecret } from "firebase-functions/params";

// Credenciales de Spotify Web API (Client Credentials flow).
// Setear con:
//   firebase functions:secrets:set SPOTIFY_CLIENT_ID
//   firebase functions:secrets:set SPOTIFY_CLIENT_SECRET
export const spotifyClientId = defineSecret("SPOTIFY_CLIENT_ID");
export const spotifyClientSecret = defineSecret("SPOTIFY_CLIENT_SECRET");
