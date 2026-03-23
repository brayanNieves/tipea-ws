/**
 * seed.ts
 * Run this once to populate Firestore with plans and sample data.
 *
 * Usage:
 *   npx ts-node seed.ts
 *
 * Make sure to set GOOGLE_APPLICATION_CREDENTIALS before running:
 *   export GOOGLE_APPLICATION_CREDENTIALS="path/to/serviceAccount.json"
 */

import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();

async function seed() {
  console.log("Seeding tipea-ws Firestore...\n");

  // ── Plans ──────────────────────────────────────────────────
  const plans = [
    {
      id: "plan_starter",
      name: "Starter",
      commissionPct: 7,
      monthlyFee: 0,
      maxTipsPerMonth: 100,
      features: ["qr_basic", "dashboard_basic"],
    },
    {
      id: "plan_pro",
      name: "Pro",
      commissionPct: 4,
      monthlyFee: 1500,
      maxTipsPerMonth: -1,
      features: ["qr_custom", "dashboard_full", "analytics", "bulk_payout"],
    },
    {
      id: "plan_business",
      name: "Business",
      commissionPct: 2,
      monthlyFee: 3500,
      maxTipsPerMonth: -1,
      features: ["qr_custom", "dashboard_full", "analytics", "bulk_payout", "priority_support"],
    },
  ];

  for (const plan of plans) {
    const { id, ...data } = plan;
    await db.doc(`plans/${id}`).set(data);
    console.log(`✓ Plan created: ${plan.name}`);
  }

  // ── Sample Users ───────────────────────────────────────────
  const users = [
    {
      id: "user_carlos",
      name: "Carlos Marte",
      email: "carlos@tipea.app",
      phone: "809-555-0001",
      role: "dj",
      planId: "plan_starter",
      pin: null,
      active: true,
      bankAccount: {
        bankName: "Banco Popular",
        accountType: "ahorros",
        accountNumber: "ENCRYPTED_PLACEHOLDER",
        accountNumberLast4: "4521",
        holderName: "Carlos Marte",
        holderCedula: "001-1234567-8",
        holderPhone: "809-555-0001",
        verified: true,
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {
      id: "user_maria",
      name: "María Sánchez",
      email: "maria@tipea.app",
      phone: "809-555-0002",
      role: "waiter",
      planId: "plan_pro",
      pin: null,
      active: true,
      bankAccount: {
        bankName: "BanReservas",
        accountType: "corriente",
        accountNumber: "ENCRYPTED_PLACEHOLDER",
        accountNumberLast4: "8832",
        holderName: "María Sánchez",
        holderCedula: "001-9876543-2",
        holderPhone: "809-555-0002",
        verified: true,
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {
      id: "user_pedro",
      name: "Pedro Díaz",
      email: "pedro@tipea.app",
      phone: "809-555-0003",
      role: "vallet",
      planId: "plan_starter",
      pin: null,
      active: true,
      bankAccount: null, // no bank account yet
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  ];

  for (const user of users) {
    const { id, ...data } = user;
    await db.doc(`users/${id}`).set(data);
    console.log(`✓ User created: ${user.name} (${user.role})`);
  }

  // ── Sample Tips ────────────────────────────────────────────

  const tips = [
    { userId: "user_carlos", amount: 500, commissionPct: 7, commissionAmt: 35, netAmount: 465, source: "qr", status: "pending" },
    { userId: "user_carlos", amount: 300, commissionPct: 7, commissionAmt: 21, netAmount: 279, source: "qr", status: "pending" },
    { userId: "user_carlos", amount: 1000, commissionPct: 7, commissionAmt: 70, netAmount: 930, source: "qr", status: "pending" },
    { userId: "user_maria", amount: 400, commissionPct: 4, commissionAmt: 16, netAmount: 384, source: "qr", status: "pending" },
    { userId: "user_maria", amount: 200, commissionPct: 4, commissionAmt: 8, netAmount: 192, source: "qr", status: "pending" },
  ];

  for (const tip of tips) {
    await db.collection("tips").add({
      ...tip,
      payoutId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  console.log(`✓ ${tips.length} sample tips created`);

  console.log("\nSeed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
