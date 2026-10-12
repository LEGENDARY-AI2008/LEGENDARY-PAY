// AI support assistant. Customers chat with it in the app. It answers questions only.
// It never moves money and never asks for a PIN, password or OTP. If it cannot help, the app offers live chat with a person.
// Uses OpenRouter (OpenAI-compatible). Set these on Render:
//   OPENROUTER_API_KEY   (required, keep it secret)
//   AI_MODEL             (optional, default below)
const DEFAULT_MODEL = 'openrouter/auto'; // OpenRouter picks any available model
const HANDOFF = '[HANDOFF]';
const LIMIT_PER_HOUR = 30;
const usage = new Map(); // uid -> { n, reset }

const SYSTEM = `Your name is Lega. You are the support assistant for Legendary Pay, a naira wallet app in Nigeria.
You help users with questions about the app: sending money, bank transfers, airtime, data, bills, savings goals, statements, limits, security and account settings.
Rules:
- Be short, clear and friendly. Use simple English. Reply in the language the user uses (English or Nigerian Pidgin).
- Never reveal which AI model, company or service powers you. If asked, say you are Lega, the Legendary Pay assistant.
- You can only explain. You cannot make, approve, cancel or change any payment, transfer, balance or setting.
- Never ask for a PIN, password, OTP, card number or fingerprint. Never ask the user to share these with anyone.
- The DATA section holds this customer's balance and their last few transactions. Use it to explain, and never invent figures. If a transaction is not in DATA, say you cannot see it and suggest History or Live chat.
- Amounts are in naira. A negative amount is money out, a positive amount is money in.
- Only explain. You cannot make, approve, cancel or change any payment, transfer, balance or setting.
- Never reveal data about any other person.
- Never promise a refund, reversal or money back. Those need a person to check.
- For a failed payment, a wrong transfer, a locked account or any complaint about money, tell the user to use Live chat with support.
- If you are not sure, or the user asks for a person, end your reply with the exact text ${HANDOFF} on its own line.`;

async function customerContext(q, uid) {
  const [acc, rows] = await Promise.all([
    q('SELECT kind, balance FROM accounts WHERE user_id=$1', [uid]),
    q(`SELECT j.kind, e.amount, j.created_at, j.meta FROM entries e
       JOIN accounts a ON a.id = e.account_id JOIN journal j ON j.id = e.journal_id
       WHERE a.user_id=$1 AND (a.kind='main' OR j.kind='bonus') ORDER BY e.id DESC LIMIT 5`, [uid]),
  ]);
  const bal = Object.fromEntries(acc.rows.map((x) => [x.kind, Number(x.balance) / 100]));
  return {
    mainBalanceNaira: bal.main ?? 0,
    bonusBalanceNaira: bal.bonus ?? 0,
    lastTransactions: rows.rows.map((x) => ({
      date: new Date(x.created_at).toISOString().slice(0, 16).replace('T', ' '),
      type: x.meta?.type || x.kind,
      amountNaira: Number(x.amount) / 100,
    })),
  };
}

function allowed(uid) {
  const now = Date.now();
  const u = usage.get(uid);
  if (!u || now > u.reset) { usage.set(uid, { n: 1, reset: now + 3600 * 1000 }); return true; }
  if (u.n >= LIMIT_PER_HOUR) return false;
  u.n += 1;
  return true;
}

export function mountAI(app, { auth, h, q }) {
  app.post('/ai/chat', auth, h(async (req, res) => {
    const key = process.env.OPENROUTER_API_KEY || '';
    if (!key) return res.status(503).json({ error: 'AI support is not set up yet. Please use Live chat.' });
    if (!allowed(req.uid)) return res.status(429).json({ error: 'You have asked many questions this hour. Please use Live chat or try again later.' });

    const input = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const messages = input.slice(-12)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Send a question first.' });
    }

    const ctx = await customerContext(q, req.uid).catch(() => null);
    const system = SYSTEM + '\n\nDATA (this customer only):\n' + JSON.stringify(ctx || { note: 'Account data is not available right now.' });

    let r;
    try {
      r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + key,
          'content-type': 'application/json',
          'HTTP-Referer': process.env.PUBLIC_API_URL || 'https://legendary-pay.vercel.app',
          'X-Title': 'Legendary Pay',
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL || DEFAULT_MODEL,
          max_tokens: 400,
          messages: [{ role: 'system', content: system }, ...messages],
        }),
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      return res.status(503).json({ error: 'The assistant is busy right now. Please use Live chat.' });
    }
    const j = await r.json().catch(() => ({}));
    const text = j?.choices?.[0]?.message?.content;
    if (!r.ok || !text) return res.status(503).json({ error: 'The assistant is busy right now. Please use Live chat.' });

    const handoff = text.includes(HANDOFF);
    const reply = text.replaceAll(HANDOFF, '').trim() || 'Let me connect you to a person.';
    res.json({ reply, handoff: handoff || undefined });
  }));
}
