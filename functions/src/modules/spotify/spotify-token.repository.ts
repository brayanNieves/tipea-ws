import { db } from "../../config/firebase";
import type { CachedSpotifyToken } from "./spotify.types";

const DOC = "appConfig/spotifyToken";

export const spotifyTokenRepo = {
  async read(): Promise<CachedSpotifyToken | null> {
    const snap = await db.doc(DOC).get();
    if (!snap.exists) return null;
    const data = snap.data() as Partial<CachedSpotifyToken> | undefined;
    if (
      typeof data?.accessToken !== "string" ||
      !data.accessToken ||
      typeof data.expiresAt !== "number" ||
      data.expiresAt <= 0
    ) {
      return null;
    }
    return { accessToken: data.accessToken, expiresAt: data.expiresAt };
  },

  async write(accessToken: string, expiresInSec: number): Promise<void> {
    await db.doc(DOC).set(
      {
        accessToken,
        expiresAt: Date.now() + expiresInSec * 1000,
        updatedAt: Date.now(),
      },
      { merge: true }
    );
  },
};
