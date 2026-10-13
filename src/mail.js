import nodemailer from 'nodemailer';

// Preferred: a Google Apps Script web app that sends through your Gmail (HTTPS, so Render allows it).
// Fallback: plain SMTP. With neither configured, emails are printed to the server log (testing).
const smtp = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_PORT === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 15000,
    })
  : null;

async function viaScript(to, subject, text) {
  const r = await fetch(process.env.MAIL_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: process.env.MAIL_WEBHOOK_KEY, to, subject, text }),
    redirect: 'follow',
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error('Mail script refused the message: ' + (j.error || r.status));
}

export async function sendMail(to, subject, text) {
  if (process.env.MAIL_WEBHOOK_URL) return viaScript(to, subject, text);
  // Never log the message body: it can hold a sign-in or PIN reset code.
  if (!smtp) return console.log(`[mail to ${to}] ${subject} (no mail server set, not sent)`);
  await smtp.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
}
