import nodemailer from 'nodemailer';

const t = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_PORT === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

// No SMTP configured: the email is printed in the server log instead (fine for testing).
export async function sendMail(to, subject, text) {
  if (!t) return console.log(`[mail to ${to}] ${subject}: ${text}`);
  await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
}
