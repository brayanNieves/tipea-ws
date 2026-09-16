// Seeds the Firestore emulator with a verified staff member so the tip page
// can be tested locally. The emulator starts empty on every run, so
// production staff don't exist there. Usage (emulators running):
//   node scripts/seed-emulator.js [staffId] [name]
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const admin = require("firebase-admin");
admin.initializeApp({ projectId: "styleapp-1e840" });
const db = admin.firestore();

const STAFF_ID = process.argv[2] || "local-staff";
const STAFF_NAME = process.argv[3] || "Staff Local";

(async () => {
  await db.doc(`users/${STAFF_ID}`).set({
    name: STAFF_NAME,
    email: `${STAFF_ID.toLowerCase()}@example.com`,
    phone: "8095550000",
    role: "waiter",
    planId: "plan_starter",
    pin: null,
    active: true,
    verificationStatus: "verified",
    bankAccount: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.doc("config/customerFee").set({ percentageFee: 8, fixedFee: 5 });
  console.log(`Seeded. Open http://localhost:3000/tip/${STAFF_ID}`);
})();
