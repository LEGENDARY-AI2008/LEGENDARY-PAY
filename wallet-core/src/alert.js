export async function alert(msg) {
  console.error('[ALERT]', msg);
  const t = process.env.TELEGRAM_BOT_TOKEN, c = process.env.TELEGRAM_CHAT_ID;
  if (!t || !c) return;
  try {
    await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: c, text: `Wallet alert: ${msg}`.slice(0, 3500) }),
    });
  } catch {}
}
