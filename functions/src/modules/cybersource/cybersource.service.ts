import {
  readCybersourceCredentials,
  readTargetOrigins,
} from "../../config/cybersource";
import { cybersourcePost } from "../../shared/http/cybersource.client";
import type { CybersourcePaymentResult, CybersourceWallet } from "./cybersource.types";

const CLIENT_VERSION = "0.23";
const CURRENCY = "DOP";
const COUNTRY = "DO";

const PAYMENT_TYPE: Record<CybersourceWallet, string> = {
  apple_pay: "APPLEPAY",
  google_pay: "GOOGLEPAY",
};

function money(amount: number): string {
  return amount.toFixed(2);
}

export const cybersourceService = {
  /**
   * Creates a Unified Checkout capture context (JWT) bound to `totalAmount`.
   * The amount always comes from the server-side session, never the client.
   */
  async createCaptureContext(totalAmount: number, wallet: CybersourceWallet): Promise<string> {
    const creds = readCybersourceCredentials();
    const origins = readTargetOrigins();
    if (origins.length === 0) {
      throw new Error("CYBERSOURCE_TARGET_ORIGINS is empty");
    }

    const payload = {
      clientVersion: CLIENT_VERSION,
      // Apple Pay only accepts a single origin — the first one is the
      // domain registered with Apple.
      targetOrigins: wallet === "apple_pay" ? [origins[0]] : origins,
      allowedCardNetworks: ["VISA", "MASTERCARD", "AMEX"],
      allowedPaymentTypes: [PAYMENT_TYPE[wallet]],
      country: COUNTRY,
      locale: "es_ES",
      captureMandate: {
        billingType: "FULL",
        requestEmail: true,
        requestPhone: false,
        requestShipping: false,
        showAcceptedNetworkIcons: true,
      },
      orderInformation: {
        amountDetails: { totalAmount: money(totalAmount), currency: CURRENCY },
      },
    };

    const res = await cybersourcePost<unknown>(creds, "/up/v1/capture-contexts", payload);
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`capture-context http ${res.status}: ${JSON.stringify(res.data)}`);
    }
    if (typeof res.data !== "string" || !res.data) {
      throw new Error("capture-context: unexpected response shape");
    }
    return res.data;
  },

  /** Authorizes and captures a transient token in one call. */
  async chargeTransientToken(params: {
    transientToken: string;
    totalAmount: number;
    referenceCode: string;
    targetUserId: string;
    senderUid: string;
  }): Promise<CybersourcePaymentResult & { httpStatus: number }> {
    const creds = readCybersourceCredentials();

    const payload = {
      clientReferenceInformation: { code: params.referenceCode },
      processingInformation: { capture: true },
      tokenInformation: { transientTokenJwt: params.transientToken },
      orderInformation: {
        amountDetails: { totalAmount: money(params.totalAmount), currency: CURRENCY },
      },
      merchantDefinedInformation: [
        { key: "1", value: params.targetUserId },
        { key: "2", value: params.senderUid },
      ],
    };

    const res = await cybersourcePost<CybersourcePaymentResult>(
      creds,
      "/pts/v2/payments",
      payload
    );
    const data = typeof res.data === "object" && res.data ? res.data : {};
    return { ...data, httpStatus: res.status };
  },
};
