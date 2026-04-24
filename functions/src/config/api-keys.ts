import { defineSecret } from "firebase-functions/params";

// API keys que protegen endpoints HTTP públicos.
// Setear con:
//   firebase functions:secrets:set SEARCH_TRACKS_API_KEY
// Rotar: el mismo comando genera una versión nueva y deja la vieja disponible
// hasta el próximo deploy. Para invalidar todas las claves previas, correr
//   firebase functions:secrets:destroy SEARCH_TRACKS_API_KEY --force
// y volver a setear.
export const searchTracksApiKey = defineSecret("SEARCH_TRACKS_API_KEY");
