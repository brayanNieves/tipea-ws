import { onRequest } from "firebase-functions/v2/https";
import { admin, db } from "../../config/firebase";
import { isAdmin } from "../../shared/auth/is-admin";
import { corsHandler } from "../../shared/utils/cors";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6;

interface FirebaseAuthError extends Error {
  code?: string;
}

// ─────────────────────────────────────────────────────────────
// updateUserCredentials (HTTP endpoint, POST, ADMIN-only)
//
// Cambia el email y/o el password de un usuario directamente vía
// Firebase Admin SDK. NO verifica el password actual — está pensado
// para flujos administrativos (ej. recuperar acceso a cuentas que
// se crearon masivamente con passwords random).
//
// Auth:
//   - Requiere Firebase ID token en header `Authorization: Bearer <idToken>`
//   - El caller debe tener `role: "admin"` en su doc `users/{uid}`
//
// Request body (JSON):
//   {
//     "email":       "user@actual.com",   // OBLIGATORIO — email actual del user
//     "newEmail":    "user@nuevo.com",    // OPCIONAL
//     "newPassword": "passwordNuevo123"   // OPCIONAL
//   }
//   Al menos uno de `newEmail` o `newPassword` es obligatorio.
//
// Response (200):
//   { "success": true, "uid": "...", "updated": { "email": true, "password": true } }
//
// Errores:
//   400 datos inválidos / nada para actualizar
//   401 sin Authorization header válido
//   403 caller no es admin
//   404 el `email` no corresponde a ninguna cuenta
//   405 método distinto a POST
//   409 el `newEmail` ya está en uso
//   500 error inesperado
// ─────────────────────────────────────────────────────────────
export const changeUserEmail = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    // ── 1. Verificar que el caller es admin ──────────────────
    const authHeader = req.get("Authorization") ?? "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.status(401).json({ error: "Falta header Authorization: Bearer <idToken>." });
      return;
    }
    const idToken = match[1];

    let callerUid: string;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      callerUid = decoded.uid;
    } catch {
      res.status(401).json({ error: "Token inválido o expirado." });
      return;
    }

    if (!(await isAdmin(callerUid))) {
      res.status(403).json({ error: "Solo administradores pueden cambiar credenciales." });
      return;
    }

    // ── 2. Validar body ──────────────────────────────────────
    const { email, newEmail, newPassword } = (req.body ?? {}) as {
      email?: string;
      newEmail?: string;
      newPassword?: string;
    };

    if (typeof email !== "string" || !EMAIL_RE.test(email)) {
      res.status(400).json({ error: "Falta o es inválido 'email'." });
      return;
    }
    if (newEmail !== undefined && (typeof newEmail !== "string" || !EMAIL_RE.test(newEmail))) {
      res.status(400).json({ error: "'newEmail' inválido." });
      return;
    }
    if (
      newPassword !== undefined &&
      (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH)
    ) {
      res.status(400).json({
        error: `'newPassword' debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
      });
      return;
    }
    if (newEmail === undefined && newPassword === undefined) {
      res
        .status(400)
        .json({ error: "Debe enviar al menos uno de 'newEmail' o 'newPassword'." });
      return;
    }

    const targetEmail = email.trim().toLowerCase();
    const newEmailNormalized = newEmail?.trim().toLowerCase();

    if (newEmailNormalized && newEmailNormalized === targetEmail) {
      res.status(400).json({ error: "El nuevo email es igual al actual." });
      return;
    }

    // ── 3. Buscar el user objetivo ───────────────────────────
    let uid: string;
    try {
      const userRecord = await admin.auth().getUserByEmail(targetEmail);
      uid = userRecord.uid;
    } catch (err) {
      const e = err as FirebaseAuthError;
      if (e.code === "auth/user-not-found") {
        res.status(404).json({ error: "No se encontró un usuario con ese email." });
        return;
      }
      console.error("[updateUserCredentials] getUserByEmail failed", err);
      res.status(500).json({ error: "Error al buscar el usuario." });
      return;
    }

    // ── 3.5. Si hay newEmail, validar que NO exista en Auth ──
    if (newEmailNormalized) {
      try {
        await admin.auth().getUserByEmail(newEmailNormalized);
        // Si llegó acá, el email ya existe → conflicto
        res
          .status(409)
          .json({ error: "El nuevo email ya está en uso por otra cuenta." });
        return;
      } catch (err) {
        const e = err as FirebaseAuthError;
        if (e.code !== "auth/user-not-found") {
          console.error("[updateUserCredentials] availability check failed", err);
          res
            .status(500)
            .json({ error: "Error al verificar disponibilidad del nuevo email." });
          return;
        }
        // user-not-found = el email está libre, seguimos
      }
    }

    // ── 4. Actualizar Firebase Auth ──────────────────────────
    const authUpdate: { email?: string; password?: string; emailVerified?: boolean } = {};
    if (newEmailNormalized) {
      authUpdate.email = newEmailNormalized;
      authUpdate.emailVerified = false;
    }
    if (newPassword) {
      authUpdate.password = newPassword;
    }

    try {
      await admin.auth().updateUser(uid, authUpdate);
    } catch (err) {
      const e = err as FirebaseAuthError;
      if (e.code === "auth/email-already-exists") {
        res
          .status(409)
          .json({ error: "El nuevo email ya está en uso por otra cuenta." });
        return;
      }
      if (e.code === "auth/invalid-email" || e.code === "auth/invalid-password") {
        res.status(400).json({ error: e.message });
        return;
      }
      console.error("[updateUserCredentials] auth update failed", err);
      res.status(500).json({ error: "Error al actualizar credenciales en Auth." });
      return;
    }

    // ── 5. Si cambió el email, actualizar Firestore ──────────
    if (newEmailNormalized) {
      try {
        await db.doc(`users/${uid}`).set(
          { email: newEmailNormalized, emailVerified: false },
          { merge: true }
        );
      } catch (err) {
        console.error("[updateUserCredentials] firestore email sync failed", err);
        res.status(200).json({
          success: true,
          uid,
          updated: { email: true, password: !!newPassword },
          warning: "Auth actualizado pero falló la sincronización del email en Firestore.",
        });
        return;
      }
    }

    console.log(
      `✅ [updateUserCredentials] caller=${callerUid} | uid=${uid} | ` +
      `email=${!!newEmailNormalized} | password=${!!newPassword}`
    );

    res.status(200).json({
      success: true,
      uid,
      updated: {
        email: !!newEmailNormalized,
        password: !!newPassword,
      },
    });
  });
});
