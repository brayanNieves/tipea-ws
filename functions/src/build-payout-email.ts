const DR_TIMEZONE = "America/Santo_Domingo";

export interface PayoutEmailData {
    // Payout document
    payoutId: string;
    grossAmount: number;
    commissionAmt: number;
    netToUser: number;
    method: string;           // "transfer" | "cash"
    bankName: string;
    accountType: string;
    accountLast4: string;
    holderName: string;
    referenceNumber: string | null;
    transferDate: string;     // ISO string
    tipCount: number;
    notes: string | null;

    // User
    staffName: string;
    staffEmail: string;
    staffRole: string;
}

function formatAmount(amount: number): string {
    return amount.toLocaleString("es-DO");
}

function formatDateTime(isoDate: string): string {
    return new Date(isoDate).toLocaleString("es-DO", {
        day: "2-digit",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: DR_TIMEZONE,
    });
}

function formatDate(isoDate: string): string {
    return new Date(isoDate).toLocaleDateString("es-DO", {
        day: "2-digit",
        month: "long",
        year: "numeric",
        timeZone: DR_TIMEZONE,
    });
}

function getInitials(name: string): string {
    return name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
}

const roleLabel: Record<string, string> = {
    dj: "DJ",
    waiter: "Mesero",
    vallet: "Valet",
    bartender: "Bartender",
    other: "Otro",
};

export function buildPayoutEmail(data: PayoutEmailData): string {
    const initials = getInitials(data.staffName);
    const firstName = data.staffName.split(" ")[0];
    const methodLabel = data.method === "transfer" ? "Transferencia bancaria" : "Efectivo";
    const methodIcon = data.method === "transfer" ? "🏦" : "💵";
    const role = roleLabel[data.staffRole] ?? data.staffRole;

    return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>¡Tu pago ha sido enviado!</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    body { margin: 0 !important; padding: 0 !important; }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#060910; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

<!-- Preview text -->
<div style="display:none; max-height:0; overflow:hidden;">
  🏦 ¡Tu pago de RD$ ${formatAmount(data.netToUser)} ha sido enviado! ${methodLabel} · ${data.bankName}
  &zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#060910; padding:40px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%;">

        <!-- Logo -->
        <tr>
          <td align="center" style="padding-bottom:32px;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:linear-gradient(135deg,#F5C518,#C9A000); border-radius:12px; padding:10px 20px;">
                  <span style="font-size:18px; font-weight:700; color:#0A0F1E; letter-spacing:-0.5px;">TipApp</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Hero Card -->
        <tr>
          <td style="padding-bottom:24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#0d2818 0%,#0a1f10 50%,#060910 100%); border:1px solid rgba(0,230,118,0.13); border-radius:20px; text-align:center;">
              <tr>
                <td style="padding:40px 32px;">
                  <!-- Avatar -->
                  <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                    <tr>
                      <td style="width:80px; height:80px; border-radius:50%; background:linear-gradient(135deg,#00E676,#00BFA5); text-align:center; font-size:28px; font-weight:700; color:#0A0F1E; line-height:80px;">
                        ${initials}
                      </td>
                    </tr>
                  </table>

                  <!-- Greeting -->
                  <p style="margin:16px 0 4px; font-size:14px; font-weight:500; color:#6b7280; text-transform:uppercase; letter-spacing:1.5px;">
                    Hola ${firstName} 👋
                  </p>

                  <!-- Headline -->
                  <h1 style="margin:0 0 8px; font-size:28px; font-weight:800; color:#ffffff; letter-spacing:-0.5px; line-height:1.2;">
                    ¡Tu pago ha sido enviado!
                  </h1>

                  <!-- Big amount -->
                  <p style="margin:16px 0 4px; font-size:56px; font-weight:800; color:#00E676; letter-spacing:-2px; line-height:1;">
                    RD$ ${formatAmount(data.netToUser)}
                  </p>

                  <!-- Meta -->
                  <p style="margin:8px 0 0; font-size:14px; color:#4b5563;">
                    ${methodIcon} ${methodLabel} · ${formatDate(data.transferDate)}
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Breakdown Card -->
        <tr>
          <td style="padding-bottom:16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117; border:1px solid rgba(255,255,255,0.07); border-radius:16px;">

              <!-- Title -->
              <tr>
                <td style="padding:16px 24px; border-bottom:1px solid rgba(255,255,255,0.06);">
                  <p style="margin:0; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:1.5px; color:#6b7280;">
                    Detalle del pago
                  </p>
                </td>
              </tr>

              <!-- Gross -->
              <tr>
                <td style="padding:16px 24px; border-bottom:1px solid rgba(255,255,255,0.03);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:14px; color:#9ca3af;">
                        Propinas acumuladas
                        <span style="margin-left:8px; background:rgba(99,102,241,0.15); border:1px solid rgba(99,102,241,0.3); border-radius:10px; padding:2px 8px; font-size:11px; color:#a5b4fc;">
                          ${data.tipCount} ${data.tipCount === 1 ? "propina" : "propinas"}
                        </span>
                      </td>
                      <td align="right" style="font-size:14px; font-weight:600; color:#e5e7eb;">
                        RD$ ${formatAmount(data.grossAmount)}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Commission -->
              <tr>
                <td style="padding:16px 24px; border-bottom:1px solid rgba(255,255,255,0.03);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:14px; color:#9ca3af;">Comisión de plataforma</td>
                      <td align="right" style="font-size:14px; font-weight:600; color:#6b7280;">
                        - RD$ ${formatAmount(data.commissionAmt)}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Net -->
              <tr>
                <td style="padding:20px 24px; background:linear-gradient(135deg,#0d2818,#0a1a10);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:15px; font-weight:700; color:#00E676;">Total recibido</td>
                      <td align="right" style="font-size:22px; font-weight:800; color:#00E676; letter-spacing:-0.5px;">
                        RD$ ${formatAmount(data.netToUser)}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

            </table>
          </td>
        </tr>

        <!-- Bank Details Card -->
        <tr>
          <td style="padding-bottom:16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117; border:1px solid rgba(255,255,255,0.07); border-radius:16px;">

              <!-- Title -->
              <tr>
                <td style="padding:16px 24px; border-bottom:1px solid rgba(255,255,255,0.06);">
                  <p style="margin:0; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:1.5px; color:#6b7280;">
                    ${methodIcon} Datos de ${data.method === "transfer" ? "transferencia" : "pago"}
                  </p>
                </td>
              </tr>

              <!-- Holder -->
              <tr>
                <td style="padding:14px 24px; border-bottom:1px solid rgba(255,255,255,0.03);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:13px; color:#6b7280;">Titular</td>
                      <td align="right" style="font-size:13px; font-weight:600; color:#e5e7eb;">${data.holderName}</td>
                    </tr>
                  </table>
                </td>
              </tr>

              ${data.method === "transfer" ? `
              <!-- Bank -->
              <tr>
                <td style="padding:14px 24px; border-bottom:1px solid rgba(255,255,255,0.03);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:13px; color:#6b7280;">Banco</td>
                      <td align="right" style="font-size:13px; font-weight:600; color:#e5e7eb;">${data.bankName}</td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Account type & last4 -->
              <tr>
                <td style="padding:14px 24px; border-bottom:1px solid rgba(255,255,255,0.03);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:13px; color:#6b7280;">Cuenta</td>
                      <td align="right" style="font-size:13px; font-weight:600; color:#e5e7eb;">
                        ${data.accountType === "ahorros" ? "Ahorros" : "Corriente"} ····${data.accountLast4}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              ${data.referenceNumber ? `
              <!-- Reference -->
              <tr>
                <td style="padding:14px 24px; border-bottom:1px solid rgba(255,255,255,0.03);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:13px; color:#6b7280;">No. de referencia</td>
                      <td align="right" style="font-size:13px; font-weight:600; color:#e5e7eb; font-family:monospace;">${data.referenceNumber}</td>
                    </tr>
                  </table>
                </td>
              </tr>
              ` : ""}
              ` : ""}

              <!-- Transfer date -->
              <tr>
                <td style="padding:14px 24px; ${data.notes ? "border-bottom:1px solid rgba(255,255,255,0.03);" : ""}">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:13px; color:#6b7280;">Fecha de transferencia</td>
                      <td align="right" style="font-size:13px; font-weight:600; color:#e5e7eb;">${formatDate(data.transferDate)}</td>
                    </tr>
                  </table>
                </td>
              </tr>

              ${data.notes ? `
              <!-- Notes -->
              <tr>
                <td style="padding:14px 24px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:13px; color:#6b7280;">Notas</td>
                      <td align="right" style="font-size:13px; color:#9ca3af; max-width:260px;">${data.notes}</td>
                    </tr>
                  </table>
                </td>
              </tr>
              ` : ""}

            </table>
          </td>
        </tr>

        <!-- Payout ID row -->
        <tr>
          <td style="padding-bottom:32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117; border:1px solid rgba(255,255,255,0.06); border-radius:12px;">
              <tr>
                <td style="padding:14px 20px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:12px; color:#4b5563;">ID de pago</td>
                      <td align="right" style="font-size:12px; color:#6b7280; font-family:monospace;">${data.payoutId.slice(0, 16)}...</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td align="center">
            <p style="margin:0; font-size:12px; color:#374151; line-height:1.8;">
              TipApp — plataforma de propinas<br/>
              <span style="color:#1f2937;">
                Si tienes alguna pregunta sobre este pago, contacta al administrador.
              </span><br/>
              <span style="color:#111827;">${formatDateTime(data.transferDate)}</span>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>
`.trim();
}
