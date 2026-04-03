export interface TipEmailData {
    // From /tips document
    tipId: string;
    amount: number;
    commissionPct: number;
    commissionAmt: number;
    netAmount: number;
    source: string;
    createdAt: string;

    // From /users document
    staffId: string;
    staffName: string;
    staffEmail: string;
    staffRole: string;
    planId: string;
    planName: string;
}

const roleEmoji: Record<string, string> = {
    dj: "🎧",
    waiter: "🍽️",
    vallet: "🚗",
    bartender: "🍸",
    other: "👤",
};

function getInitials(name: string): string {
    return name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
}

const DR_TIMEZONE = "America/Santo_Domingo";

function formatTime(isoDate: string): string {
    return new Date(isoDate).toLocaleTimeString("es-DO", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: DR_TIMEZONE,
    });
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

function formatAmount(amount: number): string {
    return amount.toLocaleString("en-US");
}

export function buildTipStaffEmail(data: TipEmailData): string {
    const emoji = roleEmoji[data.staffRole] ?? "👤";
    const initials = getInitials(data.staffName);
    const firstName = data.staffName.split(" ")[0];

    return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>¡Recibiste una propina!</title>
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
  💰 ¡Recibiste RD$ ${formatAmount(data.amount)} de propina! Tus ganancias: RD$ ${formatAmount(data.netAmount)}
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

                  <!-- Role emoji -->
                  <p style="margin:8px 0 16px; font-size:24px;">${emoji}</p>

                  <!-- Greeting -->
                  <p style="margin:0 0 8px; font-size:14px; font-weight:500; color:#6b7280; text-transform:uppercase; letter-spacing:1.5px;">
                    Hola ${firstName} 👋
                  </p>

                  <!-- Headline -->
                  <h1 style="margin:0 0 8px; font-size:32px; font-weight:800; color:#ffffff; letter-spacing:-1px; line-height:1.2;">
                    ¡Recibiste una propina!
                  </h1>

                  <!-- Big amount -->
                  <p style="margin:16px 0 4px; font-size:56px; font-weight:800; color:#00E676; letter-spacing:-2px; line-height:1;">
                    RD$ ${formatAmount(data.amount)}
                  </p>

                  <!-- Meta -->
                  <p style="margin:8px 0 0; font-size:14px; color:#4b5563;">
                    vía ${data.source === "qr" ? "escaneo QR" : "entrada manual"} · ${formatTime(data.createdAt)}
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
                    Detalle
                  </p>
                </td>
              </tr>

              <!-- Gross -->
              <tr>
                <td style="padding:16px 24px; border-bottom:1px solid rgba(255,255,255,0.03);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:14px; color:#9ca3af;">Propina recibida</td>
                      <td align="right" style="font-size:14px; font-weight:600; color:#e5e7eb;">
                        RD$ ${formatAmount(data.amount)}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Platform fee -->
              <tr>
                <td style="padding:16px 24px; border-bottom:1px solid rgba(255,255,255,0.03);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:14px; color:#9ca3af;">
                        Comisión de plataforma (${data.commissionPct}% · plan ${data.planName})
                      </td>
                      <td align="right" style="font-size:14px; font-weight:600; color:#6b7280;">
                        - RD$ ${formatAmount(data.commissionAmt)}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Net to staff -->
              <tr>
                <td style="padding:20px 24px; background:linear-gradient(135deg,#0d2818,#0a1a10);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:15px; font-weight:700; color:#00E676;">
                        Tus ganancias
                      </td>
                      <td align="right" style="font-size:22px; font-weight:800; color:#00E676; letter-spacing:-0.5px;">
                        RD$ ${formatAmount(data.netAmount)}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

            </table>
          </td>
        </tr>

        <!-- Plan badge -->
        <tr>
          <td style="padding-bottom:32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117; border:1px solid rgba(255,255,255,0.06); border-radius:12px;">
              <tr>
                <td style="padding:16px 20px;">
                  <table role="presentation" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="background:rgba(245,197,24,0.13); border:1px solid rgba(245,197,24,0.25); border-radius:20px; padding:4px 12px; font-size:12px; font-weight:600; color:#F5C518;">
                        Plan ${data.planName} · ${data.commissionPct}% de comisión
                      </td>
                      <td style="padding-left:12px; font-size:13px; color:#6b7280;">
                        Mejora tu plan para reducir tu comisión
                      </td>
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
                Tus propinas serán transferidas a tu cuenta bancaria periódicamente.
              </span><br/>
              <span style="color:#111827;">${formatDateTime(data.createdAt)}</span>
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

export function buildTipAdminEmail(data: TipEmailData): string {
    const emoji = roleEmoji[data.staffRole] ?? "👤";
    const initials = getInitials(data.staffName);
    const capitalizedRole = data.staffRole.charAt(0).toUpperCase() + data.staffRole.slice(1);

    return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>Nueva comisión generada</title>
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
  💵 Comisión generada: RD$ ${formatAmount(data.commissionAmt)} por la propina de ${data.staffName}
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
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#1a1400 0%,#120f00 50%,#060910 100%); border:1px solid rgba(245,197,24,0.13); border-radius:20px; text-align:center;">
              <tr>
                <td style="padding:40px 32px;">
                  <!-- Emoji -->
                  <p style="margin:0 0 8px; font-size:32px;">💰</p>

                  <!-- Label -->
                  <p style="margin:0 0 8px; font-size:13px; font-weight:600; color:#6b7280; text-transform:uppercase; letter-spacing:1.5px;">
                    Comisión generada
                  </p>

                  <!-- Big amount -->
                  <h1 style="margin:0 0 4px; font-size:52px; font-weight:800; color:#F5C518; letter-spacing:-2px; line-height:1;">
                    RD$ ${formatAmount(data.commissionAmt)}
                  </h1>

                  <!-- Meta -->
                  <p style="margin:8px 0 0; font-size:14px; color:#4b5563;">
                    ${data.commissionPct}% de propina de RD$ ${formatAmount(data.amount)} · plan ${data.planName}
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Staff Info + Breakdown Card -->
        <tr>
          <td style="padding-bottom:16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117; border:1px solid rgba(255,255,255,0.07); border-radius:16px;">

              <!-- Staff row -->
              <tr>
                <td style="padding:20px 24px; border-bottom:1px solid rgba(255,255,255,0.06);">
                  <table role="presentation" cellpadding="0" cellspacing="0">
                    <tr>
                      <!-- Avatar -->
                      <td style="padding-right:16px; vertical-align:middle;">
                        <table role="presentation" cellpadding="0" cellspacing="0">
                          <tr>
                            <td style="width:48px; height:48px; line-height:48px; border-radius:50%; background:linear-gradient(135deg,#00E676,#00BFA5); text-align:center; font-size:16px; font-weight:700; color:#0A0F1E;">
                              ${initials}
                            </td>
                          </tr>
                        </table>
                      </td>
                      <!-- Info -->
                      <td style="vertical-align:middle;">
                        <p style="margin:0; font-size:16px; font-weight:700; color:#ffffff;">
                          ${data.staffName} ${emoji}
                        </p>
                        <p style="margin:4px 0 0; font-size:13px; color:#6b7280;">
                          ${capitalizedRole} · Plan ${data.planName} · ID: ${data.staffId.slice(0, 8)}...
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Gross tip -->
              <tr>
                <td style="padding:16px 24px; border-bottom:1px solid rgba(255,255,255,0.03);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:14px; color:#9ca3af;">Propina bruta</td>
                      <td align="right" style="font-size:14px; font-weight:600; color:#e5e7eb;">
                        RD$ ${formatAmount(data.amount)}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Commission highlighted -->
              <tr>
                <td style="padding:20px 24px; background:linear-gradient(135deg,#1a1400,#110e00);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:15px; font-weight:700; color:#F5C518;">
                        Tu comisión (${data.commissionPct}%)
                      </td>
                      <td align="right" style="font-size:24px; font-weight:800; color:#F5C518; letter-spacing:-0.5px;">
                        + RD$ ${formatAmount(data.commissionAmt)}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Net to staff -->
              <tr>
                <td style="padding:16px 24px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:14px; color:#9ca3af;">Neto al empleado</td>
                      <td align="right" style="font-size:14px; font-weight:600; color:#6b7280;">
                        RD$ ${formatAmount(data.netAmount)}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

            </table>
          </td>
        </tr>

        <!-- Meta row -->
        <tr>
          <td style="padding-bottom:32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117; border:1px solid rgba(255,255,255,0.06); border-radius:12px;">
              <tr>
                <td style="padding:16px 24px; width:33%;">
                  <p style="margin:0 0 4px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:1px; color:#4b5563;">Origen</p>
                  <p style="margin:0; font-size:13px; color:#e5e7eb; font-family:monospace;">
                    ${data.source === "qr" ? "📱 Escaneo QR" : "✏️ Manual"}
                  </p>
                </td>
                <td style="padding:16px 24px; width:33%; text-align:center;">
                  <p style="margin:0 0 4px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:1px; color:#4b5563;">ID de propina</p>
                  <p style="margin:0; font-size:13px; color:#e5e7eb; font-family:monospace;">
                    ${data.tipId.slice(0, 12)}...
                  </p>
                </td>
                <td style="padding:16px 24px; width:33%; text-align:right;">
                  <p style="margin:0 0 4px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:1px; color:#4b5563;">Hora</p>
                  <p style="margin:0; font-size:13px; color:#e5e7eb; font-family:monospace;">
                    ${formatTime(data.createdAt)}
                  </p>
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
                Revisa tu panel para el desglose completo de ingresos.
              </span><br/>
              <span style="color:#111827;">${formatDateTime(data.createdAt)}</span>
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
