import { admin, db } from "../../config/firebase";
import { generatePassword } from "../../shared/utils/password";
import type {
  BulkCreateUserInput,
  BulkCreateUserResult,
  BulkCreateUsersResponse,
} from "./bulk-create-users.types";
import type { UserRole } from "./user.types";

const VALID_ROLES: UserRole[] = ["dj", "waiter", "vallet", "bartender", "other"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6; // Firebase Auth's minimum
const MAX_BATCH_SIZE = 100;

interface ValidationError {
  ok: false;
  error: string;
}

interface ValidationOk {
  ok: true;
  value: {
    name: string;
    email: string;
    /** undefined = backend will generate */
    password?: string;
    role: UserRole;
    phone?: string;
  };
}

function validate(input: unknown, index: number): ValidationOk | ValidationError {
  if (!input || typeof input !== "object") {
    return { ok: false, error: `Entry [${index}] must be an object` };
  }
  const e = input as Partial<BulkCreateUserInput>;

  if (typeof e.name !== "string" || !e.name.trim()) {
    return { ok: false, error: `Entry [${index}] missing/invalid 'name'` };
  }
  if (typeof e.email !== "string" || !EMAIL_RE.test(e.email)) {
    return { ok: false, error: `Entry [${index}] invalid 'email'` };
  }
  // Password is optional — if provided it must meet Firebase's minimum.
  if (e.password !== undefined) {
    if (typeof e.password !== "string" || e.password.length < MIN_PASSWORD_LENGTH) {
      return {
        ok: false,
        error: `Entry [${index}] 'password' (when provided) must be at least ${MIN_PASSWORD_LENGTH} chars`,
      };
    }
  }
  if (typeof e.role !== "string" || !VALID_ROLES.includes(e.role as UserRole)) {
    return {
      ok: false,
      error: `Entry [${index}] invalid 'role' (must be one of: ${VALID_ROLES.join(", ")})`,
    };
  }
  if (e.phone !== undefined && typeof e.phone !== "string") {
    return { ok: false, error: `Entry [${index}] 'phone' must be a string if provided` };
  }

  return {
    ok: true,
    value: {
      name: e.name.trim(),
      email: e.email.trim().toLowerCase(),
      password: e.password,
      role: e.role as UserRole,
      phone: e.phone?.trim() || undefined,
    },
  };
}

interface FirebaseAuthError extends Error {
  code?: string;
}

/**
 * Creates a single Firebase Auth user + the matching Firestore profile doc.
 * Returns a per-entry result. Never throws — failures become {status: "failed"}.
 */
async function createOne(
  raw: unknown,
  index: number
): Promise<BulkCreateUserResult> {
  const validated = validate(raw, index);
  if (!validated.ok) {
    const inputEmail =
      raw && typeof raw === "object" && "email" in raw && typeof (raw as { email: unknown }).email === "string"
        ? ((raw as { email: string }).email)
        : "<invalid>";
    return { email: inputEmail, status: "failed", error: validated.error, code: "validation/invalid" };
  }
  const { name, email, role, phone } = validated.value;
  const generated = validated.value.password === undefined;
  const password = validated.value.password ?? generatePassword();

  // Step 1: Firebase Auth (this stores the password securely; we never persist it ourselves)
  let uid: string;
  try {
    const authUser = await admin.auth().createUser({
      email,
      password,
      displayName: name,
      ...(phone ? { phoneNumber: phone } : {}),
      emailVerified: false,
      disabled: false,
    });
    uid = authUser.uid;
  } catch (err) {
    const e = err as FirebaseAuthError;
    return {
      email,
      status: "failed",
      error: e.message || "auth.createUser failed",
      code: e.code,
    };
  }

  // Step 2: Firestore profile (uses { merge: true } in case onUserCreated already ran)
  try {
    await db.doc(`users/${uid}`).set(
      {
        uid,
        name,
        email,
        phone: phone ?? null,
        role,
        planId: "plan_starter",
        active: true,
        emailVerified: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    // Firestore failed but Auth succeeded — log and surface as failure.
    // The Auth user exists; admin can retry the bulk call (will fail with email-already-exists)
    // and manually create the Firestore doc, or we could rollback by deleting the Auth user.
    // For simplicity we surface the partial state:
    const e = err as Error;
    return {
      email,
      status: "failed",
      error: `Auth user ${uid} created but Firestore profile write failed: ${e.message}`,
      code: "firestore/write-failed",
    };
  }

  return { email, uid, password, generated, status: "created" };
}

/**
 * Creates many users sequentially. Sequential (not parallel) is intentional:
 * Firebase Auth has a soft rate limit (~10 createUser/s) and parallel calls
 * with bursts of 50+ tend to get throttled. For larger batches, call this
 * endpoint multiple times.
 */
export async function bulkCreateUsers(
  rawInputs: unknown[]
): Promise<BulkCreateUsersResponse> {
  if (!Array.isArray(rawInputs)) {
    throw new Error("Input must be an array");
  }
  if (rawInputs.length === 0) {
    throw new Error("Input array is empty");
  }
  if (rawInputs.length > MAX_BATCH_SIZE) {
    throw new Error(`Max batch size is ${MAX_BATCH_SIZE} (got ${rawInputs.length})`);
  }

  const results: BulkCreateUserResult[] = [];
  for (let i = 0; i < rawInputs.length; i++) {
    results.push(await createOne(rawInputs[i], i));
  }

  const created = results.filter((r) => r.status === "created").length;
  return {
    total: results.length,
    created,
    failed: results.length - created,
    results,
  };
}
