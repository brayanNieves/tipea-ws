import nodemailer from "nodemailer";
import { buildTipStaffEmail, buildTipAdminEmail, TipEmailData } from "./build-tip-email";
import { buildErrorEmail } from "./build-error-email";

export class Mailer {
    private from = "tipapp@gmail.com";

    // ─── Core ────────────────────────────────────────────────────────────────

    public async sendMail(
        to: string,
        subject: string,
        text: string,
        html?: string
    ): Promise<boolean> {
        try {
            const transporter = this.createTransporter();
            const info = await transporter.sendMail({
                from: `"TipApp" <${this.from}>`,
                to,
                subject,
                text,
                html,
            });
            console.log(`✅ [Mailer] Mail sent → ${to} | subject: "${subject}" | id: ${info.messageId}`);
            return true;
        } catch (e) {
            console.error(`❌ [Mailer] Failed to send mail → ${to} | subject: "${subject}"`, e);
            return false;
        }
    }

    // ─── Tip emails ───────────────────────────────────────────────────────────

    public async sendTipStaffEmail(data: TipEmailData): Promise<boolean> {
        console.log(`📧 [Mailer] Sending tip email to staff → ${data.staffName} (${data.staffEmail}) | amount: RD$ ${data.amount} | net: RD$ ${data.netAmount}`);
        return this.sendMail(
            data.staffEmail,
            `💰 You received RD$ ${data.amount.toLocaleString("en-US")} tip!`,
            `Hey ${data.staffName}, you received a RD$ ${data.amount} tip. Your earnings: RD$ ${data.netAmount}.`,
            buildTipStaffEmail(data)
        );
    }

    public async sendTipAdminEmail(data: TipEmailData): Promise<boolean> {
        const adminEmail = process.env.ADMIN_EMAIL ?? "snowbook.app@gmail.com";
        console.log(`📧 [Mailer] Sending commission email to admin → ${adminEmail} | staff: ${data.staffName} | commission: RD$ ${data.commissionAmt} (${data.commissionPct}%)`);
        return this.sendMail(
            adminEmail,
            `💵 Commission: RD$ ${data.commissionAmt.toLocaleString("en-US")} from ${data.staffName}`,
            `Commission earned: RD$ ${data.commissionAmt} (${data.commissionPct}%) from ${data.staffName}'s tip.`,
            buildTipAdminEmail(data)
        );
    }

    // Sends both emails at the same time
    public async sendTipEmails(data: TipEmailData): Promise<void> {
        console.log(`📨 [Mailer] Sending tip emails (staff + admin) | tipId: ${data.tipId} | staff: ${data.staffName}`);
        const [staff, admin] = await Promise.all([
            this.sendTipStaffEmail(data),
            this.sendTipAdminEmail(data),
        ]);
        console.log(`📨 [Mailer] sendTipEmails done | staff: ${staff ? "✅" : "❌"} | admin: ${admin ? "✅" : "❌"}`);
    }

    // ─── Error email ──────────────────────────────────────────────────────────

    public async sendErrorMail(
        context: string,
        error: unknown,
        isCritical = false
    ): Promise<boolean> {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error && error.stack
            ? error.stack
            : "No stack available";
        const timestamp = new Date().toISOString();

        console.warn(`${isCritical ? "🔴" : "🟡"} [Mailer] Sending error mail | context: ${context} | critical: ${isCritical} | error: ${errorMessage}`);

        return this.sendMail(
            process.env.ADMIN_EMAIL ?? "snowbook.app@gmail.com",
            `${isCritical ? "🔴 CRITICAL" : "🟡 WARNING"}: Error in ${context}`,
            `Error in ${context}:\n\n${errorMessage}\n\nStack:\n${stack}`,
            buildErrorEmail({ context, errorMessage, stack, timestamp, isCritical })
        );
    }

    // ─── Private ──────────────────────────────────────────────────────────────
    private createTransporter() {
        return nodemailer.createTransport({
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: {
                user: "snowbook.app@gmail.com",//process.env.EMAIL,
                pass: "smcbzbxibenskqqj"//process.env.EMAIL_PASSWORD,
            },
        });
    }
}

export const mailer = new Mailer();