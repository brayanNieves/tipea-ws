# tipapp-ws — Firebase Backend

Cloud Functions + Firestore rules for the TipApp tip management platform.

---

## Project Structure

```
tipapp-ws/
├── firebase.json                  # Firebase project config
├── .firebaserc                    # Project alias
├── storage.rules                  # Firebase Storage rules
├── firestore/
│   ├── firestore.rules            # Firestore security rules
│   └── firestore.indexes.json     # Composite indexes
└── functions/
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts               # Function exports (entry point)
        ├── types.ts               # TypeScript interfaces
        ├── seed.ts                # Seed script for initial data
        ├── config/                # Firebase admin, Stripe, Spotify clients
        ├── shared/                # Cross-module utilities (auth, date, cors)
        └── modules/
            ├── tips/              # createTip, onTipCreated
            ├── payouts/           # onPayoutCreated
            ├── users/             # onUserCreated, bulk-create, change-email
            ├── summaries/         # onDayRollover
            ├── auth/              # sendOtp, verifyOtp
            ├── payments/          # createPaymentIntent (Stripe), service-fee constants
            ├── balances/          # legacy phone-based wallet (kept for back-compat)
            ├── tippers/           # hybrid wallet (anonymous-UID-keyed)
            └── spotify/           # searchTracks
```

---

## Collections

| Collection | Description | Access |
|---|---|---|
| `users` | Every DJ, waiter, vallet — staff users of the app | self read/update + admin |
| `plans` | Starter (7%), Pro (4%), Business (2%) | public read, admin write |
| `subscriptions` | Active plan per user | self read |
| `tips` | Every tip received via QR (commission baked in) | sender create, recipient read |
| `payouts` | Bank transfers you make to staff, with receipt | recipient read, admin write |
| `commissions` | Income log — one record per tip or payout | admin only |
| `daily_summaries` | Platform-wide totals per day | admin only |
| `user_daily_stats` | Per-user totals per day (leaderboard) | self read |
| `notifications` | Real-time alerts for admin | admin only |
| `otps` | One-time codes for email verification | callable-only |
| **`balances`** | Legacy phone-based wallet (deprecated path) | callable-only |
| **`topups`** | Append-only ledger of all wallet recharges | callable-only |
| **`tippers`** | Hybrid wallet keyed by anonymous Firebase UID — counts tips, holds wallet balance, drives onboarding trigger | callable-only |
| **`wallet_events`** | Append-only analytics ledger for wallet flow events | admin read, callable-only write |

---

## Cloud Functions

All functions are **HTTPS Callable** (`onCall`) unless noted. Callables require an authenticated Firebase user (anonymous auth is fine for client tippers; staff/admin must be email-authed).

### Tips

#### `createTip` (callable)
Persists a new tip and lets the `onTipCreated` trigger handle the rest.

- **Auth**: any authenticated user (including anonymous)
- **Request**: `{ amount: number, targetUserId: string }`
- **Response**: `{ success: true, tipId: string, message: string }`
- **Errors**: `unauthenticated`, `invalid-argument` (missing fields, amount ≤ 0), `not-found` (target user doesn't exist), `internal`
- **Side effects**: creates `/tips/{tipId}` with `senderUid` set to the caller. The `onTipCreated` trigger then computes commission, updates summaries, etc.

#### `onTipCreated` (Firestore trigger — `onDocumentCreated('tips/{tipId}')`)
Fires automatically on every new `/tips` document. Drives the entire commission pipeline.

What it does:
1. Validates the tip payload.
2. Fetches the recipient user + their plan.
3. Calculates `commissionPct`, `commissionAmt`, `netAmount` from `tip.amount` (the **original** tip — never the customer-charged total or wallet-debited amount).
4. Runs the suspicion detector (high-amount / repeat patterns).
5. Updates the tip doc with computed values + `status: "pending"`.
6. Appends to `/commissions` (income ledger).
7. Increments `/daily_summaries/{today}` and `/user_daily_stats/{userId_today}` in parallel transactions.
8. Creates an admin notification.
9. **Bumps `/tippers/{senderUid}.totalTipsCount` and `totalTipsAmount`** when `senderUid` is present (drives the wallet onboarding trigger). Non-fatal if it fails.
10. Sends a tip-received email to the staff member if `emailVerified`.

### Payouts

#### `onPayoutCreated` (Firestore trigger — `onDocumentCreated('payouts/{payoutId}')`)
Fires when an admin records a manual bank transfer in `/payouts`.

What it does:
1. Marks all `tipsIncluded` as `status: "paid"` and links them to the payout via `payoutId`.
2. Appends a settled `/commissions` record for the payout total.
3. Updates `/user_daily_stats` (moves `pending` → `paidOut`).
4. Updates `/daily_summaries.totalPaidOut`.
5. Creates an admin notification.

### Users

#### `onUserCreated` (Auth trigger — `functions.auth.user().onCreate`)
Fires when a new staff user signs up via Firebase Auth.

What it does:
1. Creates the Firestore profile at `/users/{uid}` (uses `merge: true` to avoid clobbering form data).
2. Assigns `plan_starter` by default.
3. Creates an active `/subscriptions/{uid}` with a 1-month renewal date.
4. Creates an admin notification.

#### `bulkCreateUsers` (callable, **admin-only**)
Creates many Firebase Auth users + their Firestore profiles in a single call. Passwords stay in Firebase Auth — never persisted in Firestore.

- **Auth**: caller must be authenticated AND have `role: "admin"` in their `/users/{uid}` profile.
- **Request**:
  ```json
  {
    "users": [
      { "name": "...", "email": "...", "password": "...", "phone": "+18095551234", "role": "dj" }
    ]
  }
  ```
  - Max 100 entries per call.
  - `role`: `"dj" | "waiter" | "vallet" | "bartender" | "other"`.
  - Password ≥ 6 chars (Firebase Auth minimum).
  - `phone` optional, must be E.164 if provided.
- **Response**: `{ total, created, failed, results: [...] }` — per-row status.
- **Errors**: `unauthenticated`, `permission-denied`, `invalid-argument`.

#### `changeUserEmail` (HTTP endpoint, POST, **admin-only**)
Changes a user's email and/or password directly via the Admin SDK. Skips current-password verification — designed for admin recovery flows. See [`functions/CHANGE_USER_EMAIL.md`](functions/CHANGE_USER_EMAIL.md) for full details.

- **Auth**: header `Authorization: Bearer <idToken>`. Caller must be admin.
- **Request body**:
  ```json
  { "email": "user@actual.com", "newEmail": "user@nuevo.com", "newPassword": "..." }
  ```
  At least one of `newEmail` or `newPassword` is required.
- **Response 200**: `{ "success": true, "uid": "...", "updated": { "email": true, "password": true } }`
- **Errors**: 400 / 401 / 403 / 404 / 405 / 409 / 500.

### Summaries / Cron

#### `onDayRollover` (scheduled, `0 0 * * *` America/Santo_Domingo)
Closes yesterday's `/daily_summaries/{date}` doc with `closed: true` and `closedAt`. No-op if the doc doesn't exist.

### Auth / OTP

#### `sendOtp` (HTTP endpoint, POST)
Generates a 6-digit OTP and emails it to the provided address.

- **Request**: `{ "email": "user@example.com" }`
- **Response**: `{ "success": true, "message": "Verification code sent to your email." }`
- **Errors**: 400 (invalid email), 405, 429 (rate-limited: 1 request per minute per email), 500.
- **Behavior**: code expires in 10 minutes, max 5 attempts, persisted at `/otps/{email}`.

#### `verifyOtp` (HTTP endpoint, POST)
Validates the 6-digit code for a given email.

- **Request**: `{ "email": "user@example.com", "code": "123456" }`
- **Response**: `{ "success": true, "message": "Email verified successfully." }`
- **Errors**: 400 (incorrect / malformed), 404 (no code on file), 410 (expired), 429 (too many attempts), 500.
- **Behavior**: deletes the `/otps/{email}` doc on success or after max attempts.

### Payments — Stripe

#### `createPaymentIntent` (callable, **direct-tip path**)
Creates a Stripe PaymentIntent for the customer-pays-with-card flow. The customer is charged `amount + 6.6% service fee` (a hardcoded constant in [`payments/service-fee.ts`](functions/src/modules/payments/service-fee.ts)).

- **Secrets used**: `STRIPE_SECRET_KEY`
- **Auth**: any authenticated user
- **Request**: `{ amount: number, targetUserId: string, currency?: "dop" }` — `amount` in DOP (e.g. `500` = RD$ 500).
- **Response**:
  ```ts
  {
    clientSecret: string,
    paymentIntentId: string,
    amountPesos: number,
    feePct: number,        // 6.6
    feeAmount: number,     // service fee in DOP
    totalChargedDop: number,
    displayAmount: number, // value to show on Apple Pay / UI
    displayCurrency: "USD" | "DOP",
    chargedCurrency: "usd" | "dop",
    amountUsd?: number, dopRate?: number, rateSource?: string  // USD mode only
  }
  ```
- **Modes** (controlled by Firestore `appConfig/payment.chargeInUsd`, default `false`):
  - **DOP mode**: charges directly in DOP centavos.
  - **USD mode**: converts via cached exchange rate (24h TTL, fallback 59 DOP/USD) and charges in USD.
- **Errors**: `unauthenticated`, `invalid-argument`, `not-found` (target staff doesn't exist), `failed-precondition`, `unknown`.
- **Note**: the FE creates the `/tips` doc itself after Stripe confirms — including `senderUid` for the trigger.

### Customer Balances (legacy phone-based wallet — kept for back-compat)

The phone-based flow was superseded by the UID-based hybrid wallet (below). Endpoints remain functional but the new UI doesn't reach them.

#### `lookupBalance` (callable)
Resolves a phone number to a `customerId` (sha-256 of normalized phone, first 32 hex chars) and returns the current balance.

- **Request**: `{ phone: string }` — DR phone, 10 digits after normalization.
- **Response**: `{ customerId: string, phone: string, balance: number, exists: boolean }`
- **Errors**: `unauthenticated`, `invalid-argument`.

#### `createTopupIntent` (callable)
Creates a Stripe PaymentIntent for a phone-based top-up. **No fee uplift** — customer pays exactly `amount`; TipApp absorbs Stripe's fee.

- **Secrets**: `STRIPE_SECRET_KEY`
- **Request**: `{ phone, amount, email? }` — `amount` ≥ 200 DOP.
- **Response**: `{ clientSecret, paymentIntentId, customerId, amount }`
- **Errors**: `unauthenticated`, `invalid-argument`, `failed-precondition`, `unknown`.

#### `confirmTopup` (callable, **idempotent**)
Verifies the PaymentIntent succeeded with Stripe, then atomically credits `/balances/{customerId}` and creates a `/topups` ledger entry. Idempotent on `paymentIntentId` — calling twice will not double-credit.

- **Request**: `{ phone, amount, paymentIntentId, email? }`
- **Response**: `{ balance: number, alreadyApplied: boolean }`
- **Errors**: `unauthenticated`, `invalid-argument`, `not-found`, `failed-precondition`, `permission-denied`.

#### `tipFromBalance` (callable)
Atomically debits the customer balance and creates a `/tips` doc with `paidFromBalance: true`. The `onTipCreated` trigger then computes commission off `tip.amount` (unchanged behavior).

- **Request**: `{ phone, staffId, amount, songRequest?, rating?, comment? }`
- **Response**: `{ tipId: string, remainingBalance: number }`
- **Errors**: `unauthenticated`, `invalid-argument`, `not-found` (staff missing), `failed-precondition` (no balance / insufficient).

### Hybrid Wallet (UID-based — current flow)

The hybrid wallet is keyed by the customer's anonymous Firebase UID. The onboarding modal only fires after the customer has demonstrated repeat usage:

```
shouldShowOnboarding =
  (totalTipsCount >= 2 OR totalTipsAmount >= 500 DOP)
  AND hasSeenWalletOnboarding == false
```

#### `getTipper` (callable)
Returns the tipper snapshot for the current `request.auth.uid`. Returns a zero-snapshot when the doc doesn't exist (so the FE can decide whether to show onboarding without distinguishing missing-vs-empty).

- **Request**: `{}`
- **Response**:
  ```ts
  {
    uid: string,
    totalTipsCount: number,
    totalTipsAmount: number,        // DOP
    walletBalance: number,          // DOP
    totalLoaded: number,
    totalSpentFromWallet: number,
    hasSeenWalletOnboarding: boolean,
    exists: boolean
  }
  ```
- **Errors**: `unauthenticated`.

#### `markOnboardingSeen` (callable, **idempotent**)
Flips `/tippers/{uid}.hasSeenWalletOnboarding = true` so the modal never re-fires for that anonymous identity. Also logs an `onboarding_dismissed` analytics event (fire-and-forget).

- **Request**: `{}`
- **Response**: `{ ok: true }`
- **Errors**: `unauthenticated`.

#### `createWalletTopupIntent` (callable)
Creates a Stripe PaymentIntent for a wallet top-up. **No fee uplift** — customer pays exactly `amount`. Backed metadata: `{ purpose: "wallet-topup", uid, amountPesos }`.

- **Secrets**: `STRIPE_SECRET_KEY`
- **Request**: `{ amount: number }` — DOP, ≥ 200.
- **Response**: `{ clientSecret, paymentIntentId, amount }`
- **Errors**: `unauthenticated`, `invalid-argument`, `failed-precondition`, `unknown`.
- **Side effect**: emits `topup_intent_created` analytics event.

#### `confirmWalletTopup` (callable, **idempotent**)
Verifies the PaymentIntent with Stripe (asserts `status=succeeded`, `metadata.purpose='wallet-topup'`, `metadata.uid` matches caller, `amount` matches), then atomically credits `/tippers/{uid}.walletBalance` and appends to `/topups`. Calling twice with the same PI ID returns the current balance unchanged with `alreadyApplied: true`.

- **Secrets**: `STRIPE_SECRET_KEY`
- **Request**: `{ amount, paymentIntentId }`
- **Response**: `{ balance: number, alreadyApplied: boolean }`
- **Errors**: `unauthenticated`, `invalid-argument`, `not-found` (unknown PI), `failed-precondition` (status/purpose/amount mismatch), `permission-denied` (PI belongs to another user).
- **Side effect**: emits `topup_success` analytics event when not duplicate.

#### `tipFromWallet` (callable)
Atomically debits `/tippers/{uid}.walletBalance` and creates a `/tips` doc with `paidFromWallet: true, senderUid: uid`. The `onTipCreated` trigger then computes commission as usual.

- **Request**: `{ staffId, amount, songRequest?, rating?, comment? }`
- **Response**: `{ tipId: string, remainingBalance: number }`
- **Errors**: `unauthenticated`, `invalid-argument`, `not-found` (staff missing), `failed-precondition` (no wallet / insufficient — emits `wallet_insufficient` analytics).

#### `logWalletEvent` (callable)
Lightweight client-side analytics endpoint. Used for events the frontend is the source of truth for (e.g. `onboarding_shown`).

- **Request**: `{ type: "onboarding_shown" | "onboarding_dismissed" | "wallet_tip" | "wallet_insufficient", amount?, staffId? }`
- **Response**: `{ ok: true }`
- **Errors**: `unauthenticated`, `invalid-argument` (unsupported event type).

### Spotify

#### `searchTracks` (HTTP endpoint, GET or POST, **API-key protected**)
Searches Spotify's catalog. The Bearer token lives in the backend — clients never see it.

- **Secrets**: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SEARCH_TRACKS_API_KEY`
- **Auth**: header `x-api-key: <SEARCH_TRACKS_API_KEY>`
- **GET** `/searchTracks?q=<query>&limit=<1..50>&offset=<n>&market=DO`
- **POST** body: `{ q, limit?, offset?, market? }`
- **Response 200**: Spotify's raw search payload — `{ tracks: { items: [...], total, limit, offset } }`.
- **Errors**: 400 (missing `q`), 401 (no api-key header), 403 (invalid api-key), 405, 502 (upstream Spotify failure).

---

## Setup

### 1. Install Firebase CLI

```bash
npm install -g firebase-tools
firebase login
```

### 2. Create your Firebase project

Go to [console.firebase.google.com](https://console.firebase.google.com) and create a project named `tipea-ws`.

Enable:
- **Firestore** (production mode)
- **Authentication** (Email/Password)
- **Storage**
- **Functions** (requires Blaze plan for cron jobs)

### 3. Link this project

```bash
firebase use tipea-ws
```

Or update `.firebaserc` with your actual project ID.

### 4. Install function dependencies

```bash
cd functions
npm install
```

### 5. Seed the database with plans

```bash
# Set your service account credentials
export GOOGLE_APPLICATION_CREDENTIALS="path/to/serviceAccount.json"

# Run seed
npx ts-node src/seed.ts
```

Download your service account key from:
Firebase Console → Project Settings → Service Accounts → Generate new private key

### 6. Deploy

#### Build (siempre antes de deployar)

```bash
cd functions && npm run build && cd ..
```

#### Deployar todo

```bash
firebase deploy
```

#### Deployar por componente

| Quiero deployar... | Comando |
|---|---|
| Todas las Cloud Functions | `firebase deploy --only functions` |
| Reglas de Firestore | `firebase deploy --only firestore:rules` |
| Índices de Firestore | `firebase deploy --only firestore:indexes` |
| Reglas de Storage | `firebase deploy --only storage` |

#### Deployar una Cloud Function individual

```bash
# Tips
firebase deploy --only functions:onTipCreated
firebase deploy --only functions:createTip

# Payouts
firebase deploy --only functions:onPayoutCreated

# Users
firebase deploy --only functions:onUserCreated
firebase deploy --only functions:bulkCreateUsers
firebase deploy --only functions:changeUserEmail

# Summaries / cron
firebase deploy --only functions:onDayRollover

# Auth / OTP
firebase deploy --only functions:sendOtp
firebase deploy --only functions:verifyOtp

# Payments (Stripe)
firebase deploy --only functions:createPaymentIntent

# Customer balances (legacy phone-based)
firebase deploy --only functions:lookupBalance
firebase deploy --only functions:createTopupIntent
firebase deploy --only functions:confirmTopup
firebase deploy --only functions:tipFromBalance

# Hybrid wallet (UID-based — current flow)
firebase deploy --only functions:getTipper
firebase deploy --only functions:markOnboardingSeen
firebase deploy --only functions:createWalletTopupIntent
firebase deploy --only functions:confirmWalletTopup
firebase deploy --only functions:tipFromWallet
firebase deploy --only functions:logWalletEvent

# Spotify
firebase deploy --only functions:searchTracks
```

#### Deployar varias a la vez

```bash
firebase deploy --only functions:createPaymentIntent,functions:onTipCreated
```

#### Build limpio + deploy (si hay caché raro)

```bash
cd functions && rm -rf lib && npm run build && cd ..
firebase deploy --only functions:createPaymentIntent
```

#### Ver logs de una función después del deploy

```bash
firebase functions:log --only createPaymentIntent --since 5m
```

#### Borrar una Cloud Function ya deployada

```bash
firebase functions:delete <nombre> --region us-central1
```

---

## Commission Flow

```
Customer scans QR
  → tip created in /tips (amount: 500, userId: uid_carlos)
  → onTipCreated fires automatically
      → Fetches Carlos's plan (Starter: 7%)
      → Calculates: commission $35, net $465
      → Updates tip document
      → Creates /commissions record       ← your income logged
      → Updates /daily_summaries          ← live dashboard
      → Updates /user_daily_stats         ← Carlos's stats
      → Creates /notifications            ← you get notified
```

---

## Secrets

Los secretos viven en **Google Cloud Secret Manager**, no en `.env` ni en `functions:config`. Detalle completo en [`functions/SECRETS.md`](functions/SECRETS.md).

| Secret | Usado por |
|---|---|
| `STRIPE_SECRET_KEY` | `createPaymentIntent` |
| `SPOTIFY_CLIENT_ID` | `searchTracks` |
| `SPOTIFY_CLIENT_SECRET` | `searchTracks` |
| `SEARCH_TRACKS_API_KEY` | `searchTracks` (api-key del cliente) |

Setear/rotar:

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY
# pega el valor cuando pregunte; después redeploy de la función que lo usa
```

Ver lista o valor:

```bash
firebase functions:secrets:list
firebase functions:secrets:access STRIPE_SECRET_KEY
```

---

## Documentación

- 📘 [`functions/API.md`](functions/API.md) — referencia de todos los endpoints (request/response/errores)
- 🔑 [`functions/SECRETS.md`](functions/SECRETS.md) — gestión de secretos
- 👤 [`functions/CHANGE_USER_EMAIL.md`](functions/CHANGE_USER_EMAIL.md) — guía de integración del endpoint admin de cambio de credenciales

---

## Local Development

```bash
# Start emulators locally
firebase emulators:start

# Emulator UI available at:
# http://localhost:4000
```

---

## Deploying to Production

```bash
firebase deploy
```

Make sure you are on the **Blaze (pay-as-you-go)** plan to use:
- Cloud Functions (2nd gen)
- Scheduled functions (onDayRollover)
- External network calls
