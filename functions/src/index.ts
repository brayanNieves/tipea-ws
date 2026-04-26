// ─────────────────────────────────────────────────────────────
// Firebase Cloud Functions entry point.
// This file ONLY wires feature-module triggers/controllers into
// the exports Firebase deploys. All business logic lives under
// ./modules/<feature>/.
// ─────────────────────────────────────────────────────────────

// Ensures admin.initializeApp() runs before any module uses Firestore.
import "./config/firebase";

// Tips
export { onTipCreated } from "./modules/tips/tip.triggers";
export { createTip } from "./modules/tips/tip.controller";

// Payouts
export { onPayoutCreated } from "./modules/payouts/payout.triggers";

// Users
export { onUserCreated } from "./modules/users/user.triggers";
export { bulkCreateUsersFn as bulkCreateUsers } from "./modules/users/bulk-create-users.controller";

// Summaries / scheduled jobs
export { onDayRollover } from "./modules/summaries/summary.jobs";

// Auth / OTP
export { sendOtp, verifyOtp } from "./modules/auth/otp.controller";

// Payments (Stripe)
export { createPaymentIntent } from "./modules/payments/payment.controller";

// Spotify
export { searchTracks } from "./modules/spotify/spotify.controller";
