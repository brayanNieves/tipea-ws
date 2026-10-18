// Firebase Identity Toolkit REST endpoint to verify email + password.
// Uses the public Web API key (the one in firebaseConfig — safe to use server-side).
const SIGNIN_URL_BASE =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";

interface SignInResponse {
  localId: string; // Firebase UID
  email: string;
  registered?: boolean;
}

interface SignInErrorBody {
  error?: { code?: number; message?: string };
}

export class VerifyPasswordError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * Verifies a user's identity by attempting a sign-in via Firebase
 * Identity Toolkit. Does NOT create or persist any token — we only
 * care that the credentials are valid.
 *
 * Throws `VerifyPasswordError` with `.code` set to one of:
 *   - "MISSING_API_KEY"            (config issue)
 *   - "EMAIL_NOT_FOUND"            (email doesn't exist in Auth)
 *   - "INVALID_PASSWORD"           (wrong password)
 *   - "INVALID_LOGIN_CREDENTIALS"  (newer error covering both above)
 *   - "USER_DISABLED"              (account disabled)
 *   - "TOO_MANY_ATTEMPTS_TRY_LATER"
 *   - any other upstream error message string
 */
export async function verifyPasswordViaSignIn(
  email: string,
  password: string
): Promise<{ uid: string; email: string }> {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) {
    throw new VerifyPasswordError(
      "MISSING_API_KEY",
      "NEXT_PUBLIC_FIREBASE_API_KEY missing in environment"
    );
  }

  const res = await fetch(`${SIGNIN_URL_BASE}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: false }),
  });

  if (!res.ok) {
    const body: SignInErrorBody = await res.json().catch(() => ({}));
    const code = body?.error?.message ?? `HTTP_${res.status}`;
    throw new VerifyPasswordError(code, code);
  }

  const data = (await res.json()) as SignInResponse;
  if (!data.localId) {
    throw new VerifyPasswordError("INVALID_RESPONSE", "Sign-in response missing localId");
  }
  return { uid: data.localId, email: data.email };
}
