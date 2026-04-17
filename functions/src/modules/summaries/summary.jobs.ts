import * as functions from "firebase-functions/v1";
import { admin, db } from "../../config/firebase";
import { mailer } from "../../mailer_service";
import { getYesterday } from "../../shared/utils/date";

// ─────────────────────────────────────────────────────────────
// onDayRollover
// Cron job — runs every day at midnight DR time.
// Closes yesterday's summary document for reporting.
// ─────────────────────────────────────────────────────────────
export const onDayRollover = functions.pubsub
  .schedule("0 0 * * *")
  .timeZone("America/Santo_Domingo")
  .onRun(async () => {
    const yesterday = getYesterday();

    try {
      const summaryRef = db.doc(`daily_summaries/${yesterday}`);
      const summarySnap = await summaryRef.get();

      if (!summarySnap.exists) {
        console.log(`⚠️ [onDayRollover] No summary found for ${yesterday}, skipping`);
        return null;
      }

      await summaryRef.update({
        closed: true,
        closedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`✅ [onDayRollover] Day ${yesterday} closed successfully`);
      return null;
    } catch (error) {
      console.error(`❌ [onDayRollover] Failed to close day ${yesterday}`, error);
      await mailer.sendErrorMail(`onDayRollover — date: ${yesterday}`, error);
      return null;
    }
  });
