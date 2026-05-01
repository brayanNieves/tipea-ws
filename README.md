# tipea-ws — Firebase Backend

Cloud Functions + Firestore rules for the tipea tip management platform.

---

## Project Structure

```
tipea-ws/
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
        ├── index.ts               # All Cloud Functions
        ├── types.ts               # TypeScript interfaces
        └── seed.ts                # Seed script for initial data
```

---

## Collections

| Collection | Description |
|---|---|
| `users` | Every DJ, waiter, vallet — direct users of the app |
| `plans` | Starter (7%), Pro (4%), Business (2%) |
| `tips` | Every tip received via QR, with commission baked in |
| `payouts` | Bank transfers you make to users, with receipt |
| `commissions` | Your income log — one record per tip or payout |
| `daily_summaries` | Platform-wide totals per day (real-time dashboard) |
| `user_daily_stats` | Per-user totals per day (leaderboard) |
| `subscriptions` | Active plan per user |
| `notifications` | Real-time alerts for you (admin) |

---

## Cloud Functions

### `onTipCreated`
Fires every time a tip is created in `/tips`.
- Fetches the user's plan and calculates commission
- Updates the tip with `commissionPct`, `commissionAmt`, `netAmount`
- Creates a record in `/commissions`
- Updates `/daily_summaries` (platform totals)
- Updates `/user_daily_stats` (per-user stats)
- Creates a notification

### `onPayoutCreated`
Fires every time you record a payout in `/payouts`.
- Marks all included tips as `paid`
- Creates a settled commission record
- Updates `user_daily_stats` (moves pending → paidOut)
- Updates `daily_summaries`
- Creates a notification

### `onUserCreated`
Fires when a new user registers via Firebase Auth.
- Creates the Firestore user profile
- Assigns Starter plan by default
- Creates subscription record
- Notifies admin

### `onDayRollover`
Cron job — runs every day at midnight DR time.
- Closes the previous day's summary (`closed: true`)

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
