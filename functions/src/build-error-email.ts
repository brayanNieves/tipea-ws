interface ErrorEmailParams {
    context: string;
    errorMessage: string;
    stack: string;
    timestamp: string;
    isCritical: boolean;
}

export function buildErrorEmail({
    context,
    errorMessage,
    stack,
    timestamp,
    isCritical,
}: ErrorEmailParams): string {
    const severityColor = isCritical ? "#EF4444" : "#F5C518";
    const severityLabel = isCritical ? "CRITICAL" : "WARNING";
    const severityIcon = isCritical ? "🔴" : "🟡";

    // Escape HTML entities to prevent XSS and rendering issues
    const escapeHtml = (str: string) =>
        str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

    const safeContext = escapeHtml(context);
    const safeErrorMessage = escapeHtml(errorMessage);
    const safeStack = escapeHtml(stack);

    return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>Error Notification — ${safeContext}</title>
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
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body { height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; }
    a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; font-size: inherit !important; font-family: inherit !important; font-weight: inherit !important; line-height: inherit !important; }
    @media only screen and (max-width: 620px) {
      .mobile-padding { padding-left: 16px !important; padding-right: 16px !important; }
      .mobile-stack { display: block !important; width: 100% !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #0A0F1E; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <!-- Preview text -->
  <div style="display: none; max-height: 0; overflow: hidden;">
    ${severityIcon} ${severityLabel}: ${safeContext} — ${safeErrorMessage.substring(0, 100)}
    &zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
  </div>

  <!-- Main wrapper -->
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #0A0F1E;">
    <tr>
      <td align="center" style="padding: 40px 16px;" class="mobile-padding">
        
        <!-- Container -->
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px;">
          
          <!-- Header -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size: 24px; font-weight: 700; color: #FFFFFF; letter-spacing: -0.5px;">
                    TipApp
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #111827; border-radius: 12px; border: 1px solid #1F2937;">
                
                <!-- Severity Badge -->
                <tr>
                  <td style="padding: 24px 24px 0 24px;">
                    <table role="presentation" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="background-color: ${severityColor}15; border: 1px solid ${severityColor}40; border-radius: 6px; padding: 6px 12px;">
                          <span style="font-size: 12px; font-weight: 600; color: ${severityColor}; text-transform: uppercase; letter-spacing: 0.5px;">
                            ${severityIcon} ${severityLabel}
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Context Title -->
                <tr>
                  <td style="padding: 16px 24px 0 24px;">
                    <h1 style="margin: 0; font-size: 20px; font-weight: 600; color: #FFFFFF; line-height: 1.4;">
                      ${safeContext}
                    </h1>
                  </td>
                </tr>

                <!-- Timestamp -->
                <tr>
                  <td style="padding: 8px 24px 0 24px;">
                    <p style="margin: 0; font-size: 13px; color: #6B7280;">
                      ${new Date(timestamp).toLocaleString("en-US", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
    })}
                    </p>
                  </td>
                </tr>

                <!-- Divider -->
                <tr>
                  <td style="padding: 24px 24px 0 24px;">
                    <div style="height: 1px; background-color: #1F2937;"></div>
                  </td>
                </tr>

                <!-- Error Message Section -->
                <tr>
                  <td style="padding: 24px 24px 0 24px;">
                    <p style="margin: 0 0 8px 0; font-size: 11px; font-weight: 600; color: #9CA3AF; text-transform: uppercase; letter-spacing: 0.5px;">
                      Error Message
                    </p>
                    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="background-color: #0A0F1E; border-radius: 8px; border-left: 3px solid ${severityColor}; padding: 16px;">
                          <p style="margin: 0; font-size: 14px; color: #F3F4F6; line-height: 1.6;">
                            ${safeErrorMessage}
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Stack Trace Section -->
                <tr>
                  <td style="padding: 24px 24px 24px 24px;">
                    <p style="margin: 0 0 8px 0; font-size: 11px; font-weight: 600; color: #9CA3AF; text-transform: uppercase; letter-spacing: 0.5px;">
                      Stack Trace
                    </p>
                    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="background-color: #0A0F1E; border-radius: 8px; padding: 16px; overflow-x: auto;">
                          <pre style="margin: 0; font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, Courier, monospace; font-size: 12px; color: #9CA3AF; line-height: 1.7; white-space: pre-wrap; word-wrap: break-word;">${safeStack}</pre>
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
            <td align="center" style="padding: 32px 24px 0 24px;">
              <p style="margin: 0; font-size: 12px; color: #4B5563; line-height: 1.6;">
                This is an automated error notification from TipApp.
              </p>
              <p style="margin: 8px 0 0 0; font-size: 12px; color: #374151;">
                <a href="https://console.firebase.google.com" style="color: #F5C518; text-decoration: none;">View Logs</a>
                &nbsp;&middot;&nbsp;
                <a href="https://tipapp.com" style="color: #F5C518; text-decoration: none;">Dashboard</a>
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
