import {
  readCybersourceCredentials,
  readTargetOrigins,
} from "../../config/cybersource";
import { cybersourcePost } from "../../shared/http/cybersource.client";
import type {
  ConsumerAuthentication,
  CybersourcePaymentResult,
  CybersourceWallet,
  GooglePayMode,
  PayerAuthResult,
  TokenMethod,
  TransientTokenInfo,
} from "./cybersource.types";

const CLIENT_VERSION = "0.23";
const CURRENCY = "DOP";
const COUNTRY = "DO";

const PAYMENT_TYPE: Record<CybersourceWallet, string> = {
  apple_pay: "APPLEPAY",
  google_pay: "GOOGLEPAY",
};

/** Cybersource paymentSolution per wallet. */
const PAYMENT_SOLUTION: Record<CybersourceWallet, string> = {
  apple_pay: "001",
  google_pay: "012",
};

function money(amount: number): string {
  return amount.toFixed(2);
}

/**
 * Reads the Unified Checkout transient token without verifying its signature —
 * we only need the public claims that say whether EMV 3DS applies.
 *
 * Apple Pay and Google Pay CRYPTOGRAM_3DS carry a device cryptogram, so
 * Cybersource derives the ECI itself and 3DS is skipped. Google Pay PAN_ONLY
 * (a card stored in the Google account, no cryptogram) is an ordinary card and
 * does need the full Payer Authentication flow.
 */
/** Pulls a value that Cybersource may send either raw or wrapped in `{ value }`. */
function readValue(node: unknown): string | null {
  if (typeof node === "string") return node;
  if (node && typeof node === "object" && typeof (node as any).value === "string") {
    return (node as any).value;
  }
  return null;
}

/** Finds a key anywhere in the claim tree — the shape varies by token version. */
function findKey(node: unknown, key: string, depth = 0): string | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === key) {
      const value = readValue(v);
      if (value) return value;
    }
    const nested = findKey(v, key, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * Reads the Unified Checkout transient token without verifying its signature —
 * we only need the public claims that say whether EMV 3DS applies.
 *
 * Apple Pay and Google Pay CRYPTOGRAM_3DS carry a device cryptogram, so
 * Cybersource derives the ECI itself and 3DS is skipped. Google Pay PAN_ONLY
 * (a card stored in the Google account, no cryptogram) is an ordinary card and
 * does need the full Payer Authentication flow.
 *
 * `wallet` is the fallback for `data.type`: the capture context allowed a single
 * payment type, so the sheet can only have produced that one. When the mode of a
 * Google Pay token can't be read, 3DS runs — the safe side.
 */
export function decodeTransientToken(
  jwt: string,
  wallet?: CybersourceWallet
): TransientTokenInfo {
  let claims: Record<string, any> = {};
  try {
    const part = jwt.split(".")[1] ?? "";
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    claims = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch (e) {
    console.warn("[cybersource] could not decode transient token", e);
  }

  const claimed = readValue(claims?.data?.type)?.toUpperCase() ?? "";
  const fromWallet = wallet === "apple_pay" ? "APPLEPAY" : wallet === "google_pay" ? "GOOGLEPAY" : "";
  const candidate = ["APPLEPAY", "GOOGLEPAY", "PANENTRY", "CLICKTOPAY"].includes(claimed)
    ? claimed
    : fromWallet;
  const method: TokenMethod = (candidate || "UNKNOWN") as TokenMethod;

  const rawMode = findKey(claims, "transactionType");
  const googlePayMode: GooglePayMode | null =
    method === "GOOGLEPAY" && rawMode ? (rawMode.toUpperCase() as GooglePayMode) : null;

  const skip3ds =
    method === "APPLEPAY" || (method === "GOOGLEPAY" && googlePayMode === "CRYPTOGRAM_3DS");

  if (method === "GOOGLEPAY" && !googlePayMode) {
    console.log(
      `[cybersource] Google Pay token without transactionType — running 3DS. claims: ${Object.keys(
        claims ?? {}
      ).join(",")}`
    );
  }

  const billTo = claims?.data?.orderInformation?.billTo ?? claims?.content?.orderInformation?.billTo ?? null;

  return { method, googlePayMode, skip3ds, billTo };
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
        requestPhone: true,
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

  /** Step 1 of Payer Authentication: device data collection details. */
  async authenticationSetup(params: {
    transientToken: string;
    referenceCode: string;
  }): Promise<PayerAuthResult & { httpStatus: number }> {
    const creds = readCybersourceCredentials();
    const payload = {
      clientReferenceInformation: { code: params.referenceCode },
      tokenInformation: { transientTokenJwt: params.transientToken },
    };
    const res = await cybersourcePost<PayerAuthResult>(
      creds,
      "/risk/v1/authentication-setups",
      payload
    );
    return { ...(typeof res.data === "object" && res.data ? res.data : {}), httpStatus: res.status };
  },

  /** Step 2: enrollment check. Either frictionless or a step-up challenge. */
  async checkEnrollment(params: {
    transientToken: string;
    referenceCode: string;
    totalAmount: number;
    referenceId: string;
    returnUrl: string;
    billTo: Record<string, unknown> | null;
    ipAddress: string | null;
    browser: {
      httpAcceptBrowserValue?: string;
      httpBrowserLanguage?: string;
      userAgentBrowserValue?: string;
    };
  }): Promise<PayerAuthResult & { httpStatus: number }> {
    const creds = readCybersourceCredentials();
    const payload = {
      clientReferenceInformation: { code: params.referenceCode },
      orderInformation: {
        amountDetails: { totalAmount: money(params.totalAmount), currency: CURRENCY },
        ...(params.billTo ? { billTo: params.billTo } : {}),
      },
      tokenInformation: { transientTokenJwt: params.transientToken },
      consumerAuthenticationInformation: {
        deviceChannel: "Browser",
        returnUrl: params.returnUrl,
        referenceId: params.referenceId,
        transactionMode: "eCommerce",
      },
      deviceInformation: {
        ...(params.ipAddress ? { ipAddress: params.ipAddress } : {}),
        ...params.browser,
      },
    };
    const res = await cybersourcePost<PayerAuthResult>(
      creds,
      "/risk/v1/authentications",
      payload
    );
    return { ...(typeof res.data === "object" && res.data ? res.data : {}), httpStatus: res.status };
  },

  /** Step 3, only after a challenge: pulls the final authentication values. */
  async validateAuthenticationResults(params: {
    transientToken: string;
    referenceCode: string;
    totalAmount: number;
    authenticationTransactionId: string;
  }): Promise<PayerAuthResult & { httpStatus: number }> {
    const creds = readCybersourceCredentials();
    const payload = {
      clientReferenceInformation: { code: params.referenceCode },
      orderInformation: {
        amountDetails: { totalAmount: money(params.totalAmount), currency: CURRENCY },
      },
      tokenInformation: { transientTokenJwt: params.transientToken },
      consumerAuthenticationInformation: {
        authenticationTransactionId: params.authenticationTransactionId,
      },
    };
    const res = await cybersourcePost<PayerAuthResult>(
      creds,
      "/risk/v1/authentication-results",
      payload
    );
    return { ...(typeof res.data === "object" && res.data ? res.data : {}), httpStatus: res.status };
  },

  /**
   * Authorizes and captures a transient token in one call.
   *
   * Wallets with a device cryptogram send only `paymentSolution`; Cybersource
   * derives the commerce indicator from the decrypted token. A 3DS-authenticated
   * card also sends `consumerAuthenticationInformation` + `commerceIndicator`.
   */
  async chargeTransientToken(params: {
    transientToken: string;
    totalAmount: number;
    referenceCode: string;
    targetUserId: string;
    senderUid: string;
    wallet: CybersourceWallet;
    authentication?: ConsumerAuthentication | null;
  }): Promise<CybersourcePaymentResult & { httpStatus: number }> {
    const creds = readCybersourceCredentials();
    const auth = params.authentication;

    const payload = {
      clientReferenceInformation: { code: params.referenceCode },
      processingInformation: {
        capture: true,
        paymentSolution: PAYMENT_SOLUTION[params.wallet],
        ...(auth ? { commerceIndicator: auth.indicator ?? "vbv" } : {}),
      },
      tokenInformation: { transientTokenJwt: params.transientToken },
      ...(auth
        ? {
            consumerAuthenticationInformation: {
              cavv: auth.cavv,
              eciRaw: auth.eciRaw,
              xid: auth.xid,
              directoryServerTransactionId: auth.directoryServerTransactionId,
              paSpecificationVersion: auth.paSpecificationVersion,
              authenticationTransactionId: auth.authenticationTransactionId,
            },
          }
        : {}),
      orderInformation: {
        amountDetails: { totalAmount: money(params.totalAmount), currency: CURRENCY },
      },
      // VisaNet DR merchant-defined data. Same keys/values as the certified
      // integration; staffId and senderUid travel in clientReferenceInformation
      // (the session id) and are stored in /tips and /cybersourceSessions.
      merchantDefinedInformation: [
        { key: "1", value: "RETAIL" },
        { key: "2", value: creds.merchantId },
        { key: "3", value: "WEB" },
        { key: "4", value: "" },
        { key: "27", value: "TOKENIZATION NO" },
        { key: "29", value: "CEDULA" },
        { key: "30", value: "" },
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
