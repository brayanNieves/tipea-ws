import { onCall, HttpsError } from "firebase-functions/v2/https";
import { isAdmin } from "../../shared/auth/is-admin";
import { bulkCreateUsers } from "./bulk-create-users.service";

// ─────────────────────────────────────────────────────────────
// bulkCreateUsers (HTTPS Callable)
//
// Creates many Firebase Auth users + their Firestore profiles in a
// single call. Passwords are stored ONLY in Firebase Auth — never
// persisted in Firestore.
//
// Request:
//   {
//     users: [
//       { name, email, password, phone?, role },
//       ...
//     ]
//   }
//   - max 100 entries per call
//   - role: "dj" | "waiter" | "vallet" | "bartender" | "other"
//   - password: ≥ 6 chars (Firebase Auth minimum)
//   - phone: optional, must be E.164 format if provided (e.g. "+18095551234")
//
// Response:
//   {
//     total, created, failed,
//     results: [
//       { email, uid, status: "created" } |
//       { email, status: "failed", error, code? }
//     ]
//   }
//
// Auth: caller must be authenticated AND have `role === "admin"` in their
// `users/{uid}` Firestore profile.
// ─────────────────────────────────────────────────────────────
export const bulkCreateUsersFn = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }

  if (!(await isAdmin(request.auth.uid))) {
    throw new HttpsError(
      "permission-denied",
      "Solo administradores pueden crear usuarios masivamente."
    );
  }

  const { users } = (request.data ?? {}) as { users?: unknown };
  if (!Array.isArray(users)) {
    throw new HttpsError("invalid-argument", "El payload debe ser { users: [...] }.");
  }

  try {
    const summary = await bulkCreateUsers(users);

    console.log(
      `✅ [bulkCreateUsers] caller=${request.auth.uid} | total=${summary.total} | ` +
        `created=${summary.created} | failed=${summary.failed}`
    );

    return summary;
  } catch (error) {
    console.error("❌ [bulkCreateUsers]", error);
    const message = error instanceof Error ? error.message : "Bulk creation failed";
    throw new HttpsError("invalid-argument", message);
  }
});
