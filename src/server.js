import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { q, tx, settings } from './db.js';
import { post, INSUFFICIENT } from './ledger.js';
import { enqueue } from './jobs.js';
import { queueGrant } from './bonus.js';
import { settlePayout } from './payouts.js';
import { createReservedAccount, listBanks, resolveBankAccount, verifyWebhook } from './flutterwave.js';
import { sendMail } from './mail.js';
import { alert } from './alert.js';

const sandbox = process.env.SANDBOX === '1';
const required = ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_KEY',
  ...(sandbox ? [] : ['FLW_SECRET_KEY', 'FLW_WEBHOOK_HASH'])];
for (const k of required) if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }
// Live Flutterwave keys start with FLWSECK- (test keys start with FLWSECK_TEST-). Never allow sandbox mode with live keys.
if (sandbox && /^FLWSECK-/.test(process.env.FLW_SECRET_KEY || '')) {
  console.error('SANDBOX=1 must never be used with a live Flutterwave key'); process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',') : true }));
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use('/lookup', rateLimit({ windowMs: 15 * 60 * 1000, limit: 80, standardHeaders: true, legacyHeaders: false }));
app.use(['/auth', '/kyc'], rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false }));

const maskName = (n) => (n ? n.split(' ').map((w, i) => (i === 0 ? w : w[0] + '***')).join(' ') : 'Wallet user');
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
const h = (fn) => (req, res, next) => fn(req, res).catch(next);
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Emails a fresh 6-digit code and stores only its hash (15 minutes, 5 tries).
async function sendVerifyCode(uid, email) {
  const code = String(crypto.randomInt(100000, 1000000));
  await q(`UPDATE users SET verify_hash=$2, verify_expires=now() + interval '15 minutes', verify_tries=0 WHERE id=$1`, [uid, sha(code)]);
  await sendMail(email, 'Your verification code', `Your Legendary Pay code is ${code}. It expires in 15 minutes. If you did not sign up, ignore this email.`);
}
async function requireEmailVerified(uid) {
  const ok = (await q('SELECT email_verified FROM users WHERE id=$1', [uid])).rows[0]?.email_verified === true;
  if (!ok) throw httpErr(403, 'Verify your email first');
}
const naira = (k) => '₦' + (k / 100).toLocaleString('en-NG');
const sign = (id) => jwt.sign({ uid: id }, process.env.JWT_SECRET, { expiresIn: '7d' });
const validAmount = (n) => Number.isInteger(n) && n >= 1000 && n <= 50_000_000; // N10 .. N500,000 (kobo)
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

function auth(req, _res, next) {
  try { req.uid = jwt.verify((req.get('authorization') || '').replace('Bearer ', ''), process.env.JWT_SECRET).uid; next(); }
  catch { next(httpErr(401, 'Unauthorized')); }
}
function admin(req, _res, next) { safeEq(req.get('x-admin-key') || '', process.env.ADMIN_KEY) ? next() : next(httpErr(401, 'Unauthorized')); }

async function checkPin(userId, pin) {
  const u = (await q('SELECT pin_hash, pin_fails, locked_until FROM users WHERE id=$1', [userId])).rows[0];
  if (!u) throw httpErr(401, 'Unauthorized');
  if (u.locked_until && u.locked_until > new Date()) throw httpErr(423, 'PIN locked, try again later');
  if (await bcrypt.compare(String(pin || ''), u.pin_hash)) {
    if (u.pin_fails) await q('UPDATE users SET pin_fails=0 WHERE id=$1', [userId]);
    return;
  }
  const f = u.pin_fails + 1;
  await q(
    `UPDATE users SET pin_fails = CASE WHEN $2::int >= 5 THEN 0 ELSE $2::int END,
       locked_until = CASE WHEN $2::int >= 5 THEN now() + interval '30 minutes' END WHERE id=$1`, [userId, f]);
  throw httpErr(401, 'Wrong PIN');
}

async function isVerified(uid) {
  return (await q('SELECT kyc_verified FROM users WHERE id=$1', [uid])).rows[0]?.kyc_verified === true;
}
async function checkLimit(uid, verified, amount) {
  const s = await settings();
  const used = Number((await q(
    `SELECT COALESCE(SUM((meta->>'amount')::bigint),0) AS t FROM journal
     WHERE user_id=$1 AND kind IN ('internal_transfer','bank_transfer') AND created_at >= date_trunc('day', now())`, [uid])).rows[0].t);
  const limit = verified ? s.daily_limit_verified : s.daily_limit_unverified;
  if (used + amount > limit) {
    throw httpErr(403, `Daily limit reached. You can send up to ${naira(limit)} per day${verified ? '' : ' until you verify your identity'}.`);
  }
}

// ---------- auth ----------
app.post('/auth/signup', h(async (req, res) => {
  const { phone, pin, referralCode, deviceId } = req.body || {};
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^0\d{10}$/.test(phone || '') || !/^\d{4}$/.test(pin || '')) throw httpErr(400, 'Invalid phone or PIN');
  if (!validEmail(email)) throw httpErr(400, 'Enter a valid email address');
  try {
    const user = await tx(async (c) => {
      let referrer = null;
      if (referralCode) referrer = (await c.query('SELECT id FROM users WHERE referral_code=$1', [String(referralCode).toUpperCase()])).rows[0];
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      const u = (await c.query(
        `INSERT INTO users(phone, email, pin_hash, referral_code, referred_by, device_id, account_number)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id, referral_code, account_number`,
        [phone, email, await bcrypt.hash(pin, 10), code, referrer?.id || null, deviceId || null, phone.slice(1)]
      )).rows[0];
      await c.query(`INSERT INTO accounts(code, user_id, kind) VALUES($1,$2,'main'), ($3,$2,'bonus')`,
        [`u:${u.id}:main`, u.id, `u:${u.id}:bonus`]);
      return u;
    });
    sendVerifyCode(user.id, email).catch((e) => console.error('verify mail failed', e));
    res.status(201).json({ token: sign(user.id), accountNumber: user.account_number, referralCode: user.referral_code });
  } catch (e) {
    if (e.code === '23505') throw httpErr(409, 'Phone number or email already registered');
    throw e;
  }
}));

app.post('/auth/verify-email', auth, h(async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) throw httpErr(400, 'Enter the 6-digit code');
  const u = (await q('SELECT email_verified, verify_hash, verify_expires, verify_tries FROM users WHERE id=$1', [req.uid])).rows[0];
  if (!u) throw httpErr(401, 'Unauthorized');
  if (u.email_verified) return res.json({ ok: true });
  if (!u.verify_hash || !u.verify_expires || u.verify_expires < new Date() || u.verify_tries >= 5) {
    throw httpErr(400, 'Code expired. Ask for a new one.');
  }
  if (!safeEq(sha(code), u.verify_hash)) {
    await q('UPDATE users SET verify_tries=verify_tries+1 WHERE id=$1', [req.uid]);
    throw httpErr(400, 'Wrong code');
  }
  await q('UPDATE users SET email_verified=true, verify_hash=NULL, verify_expires=NULL, verify_tries=0 WHERE id=$1', [req.uid]);
  res.json({ ok: true });
}));

app.post('/auth/resend-verify', auth, h(async (req, res) => {
  const u = (await q('SELECT email, email_verified FROM users WHERE id=$1', [req.uid])).rows[0];
  if (!u) throw httpErr(401, 'Unauthorized');
  if (u.email_verified) return res.json({ ok: true });
  await sendVerifyCode(req.uid, u.email);
  res.json({ ok: true });
}));

app.post('/auth/login', h(async (req, res) => {
  const { identifier, phone, pin } = req.body || {};
  const idf = String(identifier || phone || '').trim().toLowerCase();
  const u = (await q('SELECT id FROM users WHERE phone=$1 OR email=$1', [idf])).rows[0];
  if (!u) throw httpErr(401, 'Wrong phone/email or PIN');
  await checkPin(u.id, pin);
  res.json({ token: sign(u.id) });
}));

// PIN reset by email code. Same reply whether or not the email exists.
app.post('/auth/forgot', h(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const u = (await q('SELECT id FROM users WHERE email=$1', [email])).rows[0];
  if (u) {
    const code = String(crypto.randomInt(100000, 1000000));
    await q(
      `INSERT INTO pin_resets(email, code_hash, expires_at, tries) VALUES($1,$2, now() + interval '15 minutes', 0)
       ON CONFLICT (email) DO UPDATE SET code_hash=$2, expires_at = now() + interval '15 minutes', tries=0`, [email, sha(code)]);
    await sendMail(email, 'Your PIN reset code', `Your code is ${code}. It expires in 15 minutes. If you did not ask for this, ignore this email.`);
  }
  res.json({ ok: true });
}));

app.post('/auth/reset', h(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const { code, newPin } = req.body || {};
  if (!/^\d{6}$/.test(code || '') || !/^\d{4}$/.test(newPin || '')) throw httpErr(400, 'Invalid code or PIN');
  const r = (await q('SELECT * FROM pin_resets WHERE email=$1', [email])).rows[0];
  if (!r || r.expires_at < new Date() || r.tries >= 5) throw httpErr(400, 'Code expired. Ask for a new one.');
  if (!safeEq(sha(String(code)), r.code_hash)) {
    await q('UPDATE pin_resets SET tries=tries+1 WHERE email=$1', [email]);
    throw httpErr(400, 'Wrong code');
  }
  await q('UPDATE users SET pin_hash=$2, pin_fails=0, locked_until=NULL WHERE email=$1', [email, await bcrypt.hash(newPin, 10)]);
  await q('DELETE FROM pin_resets WHERE email=$1', [email]);
  res.json({ ok: true });
}));

// ---------- identity check + funding account ----------
app.post('/kyc/verify', auth, h(async (req, res) => {
  await requireEmailVerified(req.uid);
  const fullName = String(req.body?.fullName || '').trim().replace(/\s+/g, ' ');
  const idType = req.body?.idType === 'nin' ? 'nin' : 'bvn';
  const idNumber = String(req.body?.idNumber || '').trim();
  if (fullName.split(' ').length < 2 || fullName.length < 5) throw httpErr(400, 'Enter your full name as it appears on your ID');
  if (!/^\d{11}$/.test(idNumber)) throw httpErr(400, `${idType.toUpperCase()} must be 11 digits`);
  const u = (await q('SELECT id, email, phone, kyc_verified FROM users WHERE id=$1', [req.uid])).rows[0];
  if (u.kyc_verified) throw httpErr(409, 'Already verified');
  // We keep only a keyed fingerprint (never the number) so one ID cannot open many wallets and farm bonuses.
  const fingerprint = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${idType}:${idNumber}`).digest('hex');
  if ((await q('SELECT 1 FROM users WHERE kyc_hash=$1', [fingerprint])).rowCount) throw httpErr(409, 'This ID is already linked to another wallet');
  const acc = await createReservedAccount({
    userId: u.id, email: u.email, fullName, phone: u.phone,
    bvn: idType === 'bvn' ? idNumber : undefined,
  });
  try {
    await q(`UPDATE users SET full_name=$2, kyc_hash=$3, kyc_verified=true, virtual_account=$4, virtual_bank=$5 WHERE id=$1`,
      [u.id, fullName, fingerprint, acc.accountNumber, acc.bankName]);
  } catch (e) {
    if (e.code === '23505') throw httpErr(409, 'This ID is already linked to another wallet');
    throw e;
  }
  await enqueue(null, 'evaluate_bonuses', { userId: u.id });
  res.json({ virtualAccount: acc.accountNumber, bank: acc.bankName });
}));

// ---------- wallet ----------
app.get('/wallet', auth, h(async (req, res) => {
  const r = await q('SELECT kind, balance FROM accounts WHERE user_id=$1', [req.uid]);
  const u = (await q(
    'SELECT account_number, email, referral_code, kyc_verified, email_verified, full_name, virtual_account, virtual_bank FROM users WHERE id=$1', [req.uid])).rows[0];
  const bal = Object.fromEntries(r.rows.map((x) => [x.kind, Number(x.balance)]));
  res.json({ ...u, mainKobo: bal.main, bonusKobo: bal.bonus });
}));

app.get('/wallet/history', auth, h(async (req, res) => {
  const r = await q(
    `SELECT j.kind, e.amount, j.created_at, j.meta FROM entries e
     JOIN accounts a ON a.id = e.account_id JOIN journal j ON j.id = e.journal_id
     WHERE a.user_id=$1 AND (a.kind='main' OR j.kind='bonus') ORDER BY e.id DESC LIMIT 50`, [req.uid]);
  res.json(r.rows.map((x) => ({ kind: x.kind, amountKobo: Number(x.amount), at: x.created_at, type: x.meta?.type || null })));
}));

app.post('/transfer/internal', auth, h(async (req, res) => {
  await requireEmailVerified(req.uid);
  const { toAccount, amount, pin, idemKey } = req.body || {};
  if (!validAmount(amount) || !idemKey) throw httpErr(400, 'Invalid request');
  await checkPin(req.uid, pin);
  await checkLimit(req.uid, await isVerified(req.uid), amount);
  const to = (await q('SELECT id FROM users WHERE account_number=$1', [toAccount])).rows[0];
  if (!to || to.id === req.uid) throw httpErr(400, 'Invalid recipient');
  await tx(async (c) => {
    await post(c, {
      idem: `it:${req.uid}:${idemKey}`, kind: 'internal_transfer', userId: req.uid, meta: { amount, to: to.id },
      legs: [{ account: `u:${req.uid}:main`, amount: -amount }, { account: `u:${to.id}:main`, amount }],
    });
    await enqueue(c, 'evaluate_bonuses', { userId: req.uid });
  });
  res.json({ status: 'success' });
}));

app.post('/transfer/bank', auth, h(async (req, res) => {
  await requireEmailVerified(req.uid);
  const { accountNumber, bankCode, amount, pin, idemKey } = req.body || {};
  if (!validAmount(amount) || !idemKey || !/^\d{10}$/.test(accountNumber || '') || !bankCode) throw httpErr(400, 'Invalid request');
  await checkPin(req.uid, pin);
  const verified = await isVerified(req.uid);
  if (!verified) throw httpErr(403, 'Verify your identity to send money to banks');
  await checkLimit(req.uid, verified, amount);
  const s = await settings();
  const fee = s.bank_fee, pf = s.partner_fee, net = fee - pf;
  const poolPart = Math.floor((net * s.pool_share_bps) / 10000), rev = net - poolPart;
  const idem = `bt:${req.uid}:${idemKey}`;
  await tx(async (c) => {
    const r = await post(c, {
      idem, kind: 'bank_transfer', userId: req.uid, meta: { amount, bankCode, accountNumber },
      legs: [
        { account: `u:${req.uid}:main`, amount: -(amount + fee) },
        { account: 'sys:external', amount: amount + pf },
        { account: 'sys:revenue', amount: rev },
        { account: 'sys:pool', amount: poolPart },
      ],
    });
    if (r.duplicate) return;
    const p = (await c.query(
      `INSERT INTO payouts(idem, user_id, amount, fee, partner_fee, pool_part, rev_part, bank_code, account_number)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [idem, req.uid, amount, fee, pf, poolPart, rev, bankCode, accountNumber])).rows[0];
    await enqueue(c, 'payout', { payoutId: p.id });
    await queueGrant(c, req.uid, 'cashback', idem, Math.floor((fee * s.cashback_of_fee_bps) / 10000));
    await enqueue(c, 'evaluate_bonuses', { userId: req.uid });
  });
  res.status(202).json({ status: 'processing', feeKobo: fee });
}));

// ---------- Flutterwave webhook (deposits + payout results) ----------
// Credits a deposit to the user. Deposits are matched by the email on the virtual account holder.
async function creditDeposit({ reference, userId, email, amount }) {
  return tx(async (c) => {
    const u = userId
      ? (await c.query('SELECT id FROM users WHERE id=$1', [userId])).rows[0]
      : (await c.query('SELECT id FROM users WHERE email=$1', [email || ''])).rows[0];
    if (!u) throw httpErr(404, 'unknown account');
    const r = await post(c, {
      idem: `dep:${reference}`, kind: 'deposit', userId: u.id, meta: { amount, reference },
      legs: [{ account: 'sys:external', amount: -amount }, { account: `u:${u.id}:main`, amount }],
    });
    if (!r.duplicate) await enqueue(c, 'evaluate_bonuses', { userId: u.id });
    return r;
  });
}

app.post('/webhooks/flutterwave', h(async (req, res) => {
  const sig = req.get('verif-hash') || '';
  // The sandbox may send no hash; that is only tolerated while SANDBOX=1.
  if (!(sandbox && !sig) && !verifyWebhook(sig)) throw httpErr(401, 'bad signature');
  const { event, data: d = {} } = req.body || {};
  if (event === 'charge.completed' && d.status === 'successful') {
    const amount = Math.round(Number(d.amount) * 100);
    const email = String(d.customer?.email || '').trim().toLowerCase();
    if (!d.id || !(amount > 0) || !email) throw httpErr(400, 'bad payload');
    try {
      await creditDeposit({ reference: String(d.id), email, amount });
    } catch (e) {
      if (e.status === 404) await alert(`deposit for unknown account, ref ${d.id}, email ${email}`); else throw e;
    }
  } else if (event === 'transfer.completed') {
    const m = /^payout-(\d+)$/.exec(d.reference || '');
    if (m) await settlePayout(Number(m[1]), d.status === 'SUCCESSFUL' ? 'success' : 'failed');
  }
  res.json({ ok: true });
}));

// ---------- app helpers ----------
app.get('/health', h(async (_req, res) => { await q('SELECT 1'); res.json({ ok: true }); })); // for UptimeRobot

app.get('/banks', h(async (_req, res) => {
  const s = await settings();
  res.json({ banks: await listBanks(), bankFeeKobo: s.bank_fee });
}));

app.get('/lookup/wallet', auth, h(async (req, res) => {
  const u = (await q('SELECT id, full_name FROM users WHERE account_number=$1', [String(req.query.account || '')])).rows[0];
  if (!u) throw httpErr(404, 'No wallet found with that number');
  if (u.id === req.uid) throw httpErr(400, 'That is your own wallet');
  res.json({ name: maskName(u.full_name) });
}));

app.get('/lookup/bank', auth, h(async (req, res) => {
  const accountNumber = String(req.query.accountNumber || ''), bankCode = String(req.query.bankCode || '');
  if (!/^\d{10}$/.test(accountNumber) || !bankCode) throw httpErr(400, 'Invalid account');
  res.json({ name: (await resolveBankAccount({ accountNumber, bankCode })).accountName });
}));

app.get('/rewards', auth, h(async (req, res) => {
  const g = (await q(`SELECT status, COALESCE(SUM(amount),0) AS t FROM bonus_grants WHERE user_id=$1 AND status<>'void' GROUP BY status`, [req.uid])).rows;
  const sum = (st) => Number(g.find((x) => x.status === st)?.t || 0);
  const friends = Number((await q('SELECT COUNT(*) AS n FROM users WHERE referred_by=$1', [req.uid])).rows[0].n);
  res.json({ paidKobo: sum('paid'), pendingKobo: sum('pending'), friends });
}));

// ---------- admin ----------
app.post('/admin/kyc/:userId', admin, h(async (req, res) => {
  await q('UPDATE users SET kyc_verified=$2 WHERE id=$1', [req.params.userId, req.body?.verified !== false]);
  await enqueue(null, 'evaluate_bonuses', { userId: req.params.userId });
  res.json({ ok: true });
}));

app.get('/admin/pool', admin, h(async (_req, res) => {
  const bal = await q(`SELECT code, balance FROM accounts WHERE code LIKE 'sys:%'`);
  const pend = (await q(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS t FROM bonus_grants WHERE status='pending'`)).rows[0];
  res.json({ system: Object.fromEntries(bal.rows.map((r) => [r.code, Number(r.balance)])), pendingGrants: Number(pend.n), pendingKobo: Number(pend.t) });
}));

app.patch('/admin/settings', admin, h(async (req, res) => {
  const { key, value } = req.body || {};
  if (!Number.isInteger(value) || value < 0) throw httpErr(400, 'bad value');
  const r = await q('UPDATE settings SET value=$2 WHERE key=$1', [key, value]);
  if (!r.rowCount) throw httpErr(404, 'unknown setting');
  res.json({ ok: true });
}));

if (sandbox) {
  app.post('/admin/sim-deposit', admin, h(async (req, res) => {
    const { accountNumber, amount } = req.body || {};
    const u = (await q('SELECT id FROM users WHERE account_number=$1 OR virtual_account=$1', [accountNumber])).rows[0];
    if (!u || !Number.isInteger(amount) || amount <= 0) throw httpErr(400, 'bad request');
    await creditDeposit({ reference: 'sim-' + crypto.randomUUID(), userId: u.id, amount });
    res.json({ ok: true });
  }));
}

app.get('/', (_req, res) => res.json({ ok: true }));

app.use((e, _req, res, _next) => {
  if (e.status) return res.status(e.status).json({ error: e.message });
  if (INSUFFICIENT(e)) return res.status(402).json({ error: 'Insufficient balance' });
  console.error(e);
  res.status(500).json({ error: 'Server error' });
});

// One process on a free host: the background worker runs inside the API. Set RUN_WORKER=0 to run it separately.
if (process.env.RUN_WORKER !== '0') await import('./worker.js');

app.listen(process.env.PORT || 3000, () => console.log('api up'));
