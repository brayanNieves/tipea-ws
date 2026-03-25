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

### 6. Deploy everything

```bash
# From the root of the project
firebase deploy
```

Or deploy individually:

```bash
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
firebase deploy --only storage
firebase deploy --only functions
```

firebase fi
restore:databases:list --project styleapp-1e840

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

## Environment Variables

No environment variables are needed for the base setup.
If you add Stripe later, set:

```bash
firebase functions:config:set stripe.secret="sk_live_..."
```

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
