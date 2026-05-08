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
export { changeUserEmail } from "./modules/users/change-email.controller";

// Summaries / scheduled jobs
export { onDayRollover } from "./modules/summaries/summary.jobs";

// Auth / OTP
export { sendOtp, verifyOtp } from "./modules/auth/otp.controller";

// Payments (Stripe)
export { createPaymentIntent } from "./modules/payments/payment.controller";

// Customer balances / top-ups (legacy phone-based flow — kept for back-compat)
export {
  lookupBalance,
  createTopupIntent,
  confirmTopup,
  tipFromBalance,
} from "./modules/balances/balance.controller";

// Hybrid wallet (anonymous-UID-keyed, drives the onboarding-after-N-tips flow)
export {
  getTipper,
  markOnboardingSeen,
  sendWalletOtp,
  verifyWalletOtp,
  createWalletTopupIntent,
  confirmWalletTopup,
  tipFromWallet,
  logWalletEvent,
} from "./modules/tippers/tipper.controller";

// Spotify
export { searchTracks } from "./modules/spotify/spotify.controller";
