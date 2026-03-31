export function buildOtpEmail(otp: string, expiresInMinutes: number): string {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Tu código de verificación</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:#1a1a2e;padding:32px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:24px;letter-spacing:1px;">TipApp</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 32px;text-align:center;">
              <p style="color:#555;font-size:16px;margin:0 0 24px;">Usa el siguiente código para verificar tu identidad:</p>
              <div style="background:#f0f4ff;border:2px dashed #4361ee;border-radius:8px;padding:24px;display:inline-block;margin:0 auto 24px;">
                <span style="font-size:40px;font-weight:700;letter-spacing:12px;color:#1a1a2e;">${otp}</span>
              </div>
              <p style="color:#888;font-size:14px;margin:0;">Este código expira en <strong>${expiresInMinutes} minutos</strong>.</p>
              <p style="color:#888;font-size:14px;margin:8px 0 0;">Si no solicitaste este código, ignora este correo.</p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f9f9f9;padding:20px 32px;text-align:center;border-top:1px solid #eee;">
              <p style="color:#aaa;font-size:12px;margin:0;">© ${new Date().getFullYear()} TipApp — No respondas a este correo.</p>
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
