import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { admin, db } from "../../config/firebase";
import { isAdmin } from "../../shared/auth/is-admin";

// ─────────────────────────────────────────────────────────────
// createBackofficeUser (HTTPS Callable, ADMIN-only)
//
// Creates a backoffice-only user (e.g. a salesperson) — someone who logs
// into the backoffice but does NOT receive tips. Permissions come from the
// `/access_roles/{accessRoleId}` doc referenced on their profile.
//
// Doing this server-side matters: creating the account from the browser
// with createUserWithEmailAndPassword would sign the admin out and in as
// the new user.
//
// Request:
//   { name, email, password, accessRoleId }
//   - password: ≥ 6 chars (Firebase Auth minimum)
//   - accessRoleId: must exist in /access_roles
//
// Response:
//   { uid }
//
// The profile is written BEFORE the Auth account (with a pre-generated
// uid) so the `onUserCreated` trigger sees `role: "backoffice"` and skips
// the staff plan/subscription setup.
// ─────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6;

export const createBackofficeUser = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  if (!(await isAdmin(request.auth.uid))) {
    throw new HttpsError("permission-denied", "Solo administradores pueden crear usuarios.");
  }

  const { name, email, password, accessRoleId } = (request.data ?? {}) as {
    name?: unknown;
    email?: unknown;
    password?: unknown;
    accessRoleId?: unknown;
  };

  if (typeof name !== "string" || !name.trim()) {
    throw new HttpsError("invalid-argument", "Falta el nombre.");
  }
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    throw new HttpsError("invalid-argument", "Email inválido.");
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpsError(
      "invalid-argument",
      `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`
    );
  }
  if (typeof accessRoleId !== "string" || !accessRoleId) {
    throw new HttpsError("invalid-argument", "Falta el rol de acceso.");
  }

  const roleSnap = await db.doc(`access_roles/${accessRoleId}`).get();
  if (!roleSnap.exists) {
    throw new HttpsError("not-found", "El rol de acceso no existe.");
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim();
  const userRef = db.collection("users").doc();
  const uid = userRef.id;

  await userRef.set({
    name: cleanName,
    email: cleanEmail,
    phone: "",
    role: "backoffice",
    accessRoleId,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    await admin.auth().createUser({
      uid,
      email: cleanEmail,
      password,
      displayName: cleanName,
    });
  } catch (error) {
    await userRef.delete().catch(() => undefined);
    const code = (error as { code?: string })?.code;
    if (code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "Ya existe una cuenta con ese email.");
    }
    console.error("❌ [createBackofficeUser]", error);
    throw new HttpsError("internal", "No se pudo crear el usuario.");
  }

  console.log(
    `✅ [createBackofficeUser] caller=${request.auth.uid} | uid=${uid} | role=${accessRoleId}`
  );
  return { uid };
});
