import { onRequest } from "firebase-functions/v2/https";
import { admin } from "../../config/firebase";
import { isAdmin } from "../../shared/auth/is-admin";
import { corsHandler } from "../../shared/utils/cors";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FirebaseAuthError extends Error {
  code?: string;
}

// ─────────────────────────────────────────────────────────────
// setAdminClaim (HTTP endpoint, POST, ADMIN-only)
//
// Asigna o remueve el custom claim `admin: true` en el ID token
// del usuario indicado. Las reglas de Firestore para colecciones
// admin-only (notifications, daily_summaries, payouts, tips
// globales, etc.) chequean `request.auth.token.admin == true`,
// así que sin este claim el dashboard global no carga.
//
// El usuario afectado debe cerrar sesión y volver a entrar (o
// llamar `getIdToken(true)`) para que el claim aparezca en su
// token.
//
// Auth:
//   - `Authorization: Bearer <idToken>` del caller
//   - El caller debe tener `role: "admin"` en `users/{uid}`
//     (bootstrap: el primer admin se promueve a sí mismo).
//
// Body (JSON):
//   { "email": "user@x.com", "admin": true }   // o `false` para revocar
//   uid también es aceptado en lugar de email.
// ─────────────────────────────────────────────────────────────
export const setAdminClaim = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const authHeader = req.get("Authorization") ?? "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.status(401).json({ error: "Falta header Authorization: Bearer <idToken>." });
      return;
    }

    let callerUid: string;
    try {
      const decoded = await admin.auth().verifyIdToken(match[1]);
      callerUid = decoded.uid;
    } catch {
      res.status(401).json({ error: "Token inválido o expirado." });
      return;
    }

    if (!(await isAdmin(callerUid))) {
      res.status(403).json({ error: "Solo administradores pueden asignar claims." });
      return;
    }

    const body = (req.body ?? {}) as {
      email?: string;
      uid?: string;
      admin?: boolean;
    };

    const grant = body.admin !== false;

    let targetUid: string;
    try {
      if (typeof body.uid === "string" && body.uid.trim()) {
        targetUid = body.uid.trim();
        await admin.auth().getUser(targetUid);
      } else if (typeof body.email === "string" && EMAIL_RE.test(body.email)) {
        const record = await admin.auth().getUserByEmail(body.email.trim().toLowerCase());
        targetUid = record.uid;
      } else {
        res.status(400).json({ error: "Debe enviar 'email' o 'uid'." });
        return;
      }
    } catch (err) {
      const e = err as FirebaseAuthError;
      if (e.code === "auth/user-not-found") {
        res.status(404).json({ error: "No se encontró el usuario." });
        return;
      }
      console.error("[setAdminClaim] lookup failed", err);
      res.status(500).json({ error: "Error al buscar el usuario." });
      return;
    }

    try {
      const existing = (await admin.auth().getUser(targetUid)).customClaims ?? {};
      const next = { ...existing, admin: grant };
      await admin.auth().setCustomUserClaims(targetUid, next);
    } catch (err) {
      console.error("[setAdminClaim] setCustomUserClaims failed", err);
      res.status(500).json({ error: "Error al asignar el claim." });
      return;
    }

    console.log(
      `✅ [setAdminClaim] caller=${callerUid} | target=${targetUid} | admin=${grant}`
    );

    res.status(200).json({
      success: true,
      uid: targetUid,
      admin: grant,
      note: "El usuario debe cerrar sesión y volver a entrar (o llamar getIdToken(true)) para refrescar el token.",
    });
  });
});
